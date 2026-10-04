/**
 * T1 — validator test suite for scripts/verify-profile.mjs
 *
 * Rules under test (contract owned by T1, extended later by T3):
 *   - section registry + required order
 *   - forbidden audience figures / star counts
 *   - placeholder leakage (template exempt)
 *   - link well-formedness
 *   - github repo link allowlist / private denylist / fork exclusion
 *   - image + shields badge sanity
 *   - contribution graph + GitHub Stats presence
 *   - --rules (eligibility rules)
 *   - --target-glob (multiple files, shell-expanded literals included)
 *
 * Fixtures live in a temp directory. Nothing is written into the repo.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Namespace import: lets the T3 tests reference exports that do not exist yet
// without turning a missing export into a whole-file module-load crash, so a
// failing new test is a failing test, not 0 tests run.
import * as verifier from "./verify-profile.mjs";

import {
  SECTION_REGISTRY,
  REQUIRED_SECTION_ORDER,
  KNOWN_PUBLIC_REPOS,
  PRIVATE_REPOS_WITHOUT_WEBSITE,
  PRIVATE_REPOS_WITH_WEBSITE,
  FORBIDDEN_REPO_NAMES,
  FORBIDDEN_FIGURE_PATTERNS,
  sectionForFilename,
  expandGlob,
  validateContent,
  validateFile,
  checkEligibilityRules,
  checkForbiddenFigures,
  checkPlaceholders,
  checkSectionOrder,
  checkLinks,
  checkGitHubRepoLinks,
  checkImagesAndBadges,
  checkStatsPresence,
  checkHtmlBoundaries,
  main,
} from "./verify-profile.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const SCRIPT = join(HERE, "verify-profile.mjs");

const tmpRoot = mkdtempSync(join(tmpdir(), "verify-profile-test-"));
process.on("exit", () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

let fixtureSeq = 0;
/** Write a fixture file into the temp dir and return its absolute path. */
function fixture(relName, content) {
  const abs = join(tmpRoot, `f${fixtureSeq++}`, relName);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

/** Rules of a failure, in order. */
function rulesOf(failures) {
  return failures.map((f) => f.rule);
}

/** Run the CLI, returning { code, out }. */
function runCli(args) {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
}

const VALID_BADGE_ROW = `<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust" alt="Rust" />
</p>`;

const VALID_STATS_BLOCK = `<p align="center">
  <img src="https://gitlyy.vercel.app/api/contribution?username=belajarcarabelajar&hide_border=true" alt="GitHub Activity Graph" />
  <img src="https://github-stats-extended.vercel.app/api?username=belajarcarabelajar&show_icons=true&theme=tokyonight" alt="GitHub Stats" />
</p>`;

/**
 * A README that satisfies every T1 check: all 13 sections, correct order,
 * valid links, valid badges, stats present, no forbidden figures.
 */
function validReadme() {
  return [
    `<h1 align="center">Hi there, I'm Iwan Kurniawan 👋</h1>`,
    ``,
    `<!-- section: identity -->`,
    `📍 Bandung, Indonesia · 🎓 Author & educator · 🛠️ Builder — Rust, Tauri, TypeScript, Cloudflare`,
    ``,
    `<!-- section: badges -->`,
    VALID_BADGE_ROW,
    ``,
    `<!-- section: starthere -->`,
    `## 🏠 Start Here`,
    ``,
    `- [Snipset](https://snipset.belajarcarabelajar.com) — encrypted note-taking that syncs to Obsidian.`,
    `- [vivera](https://github.com/belajarcarabelajar/vivera) — the AI agent runtime behind this profile.`,
    `- [dawnbook](https://dawnbook.belajarcarabelajar.com/) — Markdown book publishing on mdBook.`,
    ``,
    `<!-- section: activity -->`,
    `## 📈 Activity`,
    VALID_STATS_BLOCK,
    ``,
    `<!-- section: what-im-doing -->`,
    `## 🔨 What I'm Doing`,
    ``,
    `Shipping the agent pipeline, writing about Rust, and answering e-mail.`,
    ``,
    `<!-- section: projects-flagship -->`,
    `## 🚀 Flagship Products`,
    ``,
    `- [Snipset](https://snipset.belajarcarabelajar.com)`,
    ``,
    `<!-- section: projects-oss -->`,
    `## 🐙 Open Source`,
    ``,
    `- [vivera](https://github.com/belajarcarabelajar/vivera)`,
    ``,
    `<!-- section: projects-ai -->`,
    `## 🤖 AI & Automation`,
    ``,
    `- [snipset-cli](https://github.com/belajarcarabelajar/snipset-cli) — the Snipset command line.`,
    ``,
    `<!-- section: projects-tools -->`,
    `## 🧰 Tools & Distribution`,
    ``,
    `- [snipset-cli](https://github.com/belajarcarabelajar/snipset-cli) — installers for the Snipset CLI.`,
    ``,
    `<!-- section: connect -->`,
    `## 🔌 Connect`,
    ``,
    `- [belajarcarabelajar.com](https://belajarcarabelajar.com)`,
    ``,
    `<!-- section: philosophy-facts -->`,
    `## 🧭 Philosophy`,
    ``,
    `<details><summary>Random Facts</summary>`,
    ``,
    `I collect typefaces nobody asked for.`,
    ``,
    `</details>`,
    ``,
  ].join("\n");
}

/* ------------------------------------------------------------------ */

describe("section registry", () => {
  test("maps every documented filename prefix to its section", () => {
    const expected = {
      "10-identity.md": "identity",
      "15-badges.md": "badges",
      "20-starthere.md": "starthere",
      "21-activity.md": "activity",
      "25-what-im-doing.md": "what-im-doing",
      "26-projects-flagship.md": "projects-flagship",
      "27-projects-oss.md": "projects-oss",
      "28-projects-ai.md": "projects-ai",
      "29-projects-tools.md": "projects-tools",
      "30-connect.md": "connect",
      "38-philosophy-facts.md": "philosophy-facts",
      "README.md": "all",
      "PROFILE-README.template.md": "template",
    };
    for (const [filename, section] of Object.entries(expected)) {
      expect(sectionForFilename(filename)).toBe(section);
    }
  });

  test("required order is identity → badges → starthere → activity → what-im-doing → projects → connect → philosophy-facts", () => {
    expect(REQUIRED_SECTION_ORDER).toEqual([
      "identity",
      "badges",
      "starthere",
      "activity",
      "what-im-doing",
      "projects-flagship",
      "projects-oss",
      "projects-ai",
      "projects-tools",
      "connect",
      "philosophy-facts",
    ]);
  });

  test("registry covers exactly the 11 fragments plus README and the template", () => {
    expect(SECTION_REGISTRY.length).toBe(13);
    for (const required of REQUIRED_SECTION_ORDER) {
      expect(SECTION_REGISTRY.some((e) => e.section === required)).toBe(true);
    }
  });
});

describe("section presence and order", () => {
  test("correct order passes", () => {
    const failures = checkSectionOrder({
      content: validReadme(),
      file: "README.md",
      section: "all",
    });
    expect(failures).toEqual([]);
  });

  test("wrong order fails and names both sections", () => {
    // Cut the badges block out and re-insert it after Start Here, so the
    // detected sequence becomes identity, starthere, badges, activity, ...
    const withoutBadges = validReadme().replace(
      `<!-- section: badges -->\n${VALID_BADGE_ROW}\n\n`,
      ``,
    );
    const content = withoutBadges.replace(
      `<!-- section: activity -->`,
      `<!-- section: badges -->\n${VALID_BADGE_ROW}\n\n<!-- section: activity -->`,
    );
    const failures = checkSectionOrder({ content, file: "README.md", section: "all" });
    expect(rulesOf(failures)).toContain("section-order");
    expect(failures[0].message).toContain("badges");
    expect(failures[0].message).toContain("starthere");
  });

  test("missing section fails", () => {
    const content = validReadme()
      .replace(`<!-- section: what-im-doing -->\n## 🔨 What I'm Doing\n\nShipping the agent pipeline, writing about Rust, and answering e-mail.\n\n`, ``);
    const failures = checkSectionOrder({ content, file: "README.md", section: "all" });
    expect(rulesOf(failures)).toContain("section-missing");
    expect(failures[0].message).toContain("what-im-doing");
  });

  test("duplicate section fails", () => {
    const content = validReadme() + `\n<!-- section: what-im-doing -->\n`;
    const failures = checkSectionOrder({ content, file: "README.md", section: "all" });
    expect(rulesOf(failures)).toContain("section-duplicate");
    expect(failures[0].message).toContain("what-im-doing");
  });
});

describe("forbidden audience figures", () => {
  const cases = [
    ["500K+ learners", `Trusted by 500K+ learners worldwide.`],
    ["500,000 students", `A community of 500,000 students.`],
    ["302K", `Reading now: 302K.`],
    ["followers", `Join my followers on the channel.`],
    ["star count in parens", `[vivera](https://github.com/belajarcarabelajar/vivera) (1.2k+ stars)`],
    ["star emoji", `⭐ 42`],
    ["10M+", `Over 10M+ downloads.`],
  ];

  for (const [label, line] of cases) {
    test(`fails on ${label}`, () => {
      const failures = checkForbiddenFigures({
        content: `${line}\n`,
        file: "README.md",
        section: "all",
      });
      expect(rulesOf(failures)).toContain("forbidden-figure");
      expect(failures[0].file).toBe("README.md");
      expect(failures[0].section).toBe("all");
    });
  }

  test("forbidden-figure patterns list is not empty", () => {
    expect(FORBIDDEN_FIGURE_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("exceptions", () => {
  test("EXCEPTION 1 — a GitHub Stats card URL may carry username= and passes", () => {
    const content = VALID_STATS_BLOCK;
    const failures = checkForbiddenFigures({ content, file: "README.md", section: "all" });
    expect(failures).toEqual([]);
  });

  test("EXCEPTION 1 is narrow — a forbidden token inside the stats card URL still fails", () => {
    const content = `<img src="https://github-stats-extended.vercel.app/api?username=belajarcarabelajar&caption=500K%20learners" alt="GitHub Stats" />`;
    const failures = checkForbiddenFigures({ content, file: "README.md", section: "all" });
    expect(rulesOf(failures)).toContain("forbidden-figure");
  });

  test("EXCEPTION 2 — [PLACEHOLDER] is allowed in the template", () => {
    const content = `## Connect\n\n- [Email](mailto:[PLACEHOLDER])\n- [Website]([PLACEHOLDER])\n`;
    const failures = checkPlaceholders({
      content,
      file: "docs/PROFILE-README.template.md",
      section: "template",
    });
    expect(failures).toEqual([]);
  });

  test("EXCEPTION 2 — [PLACEHOLDER] fails in README.md", () => {
    const failures = checkPlaceholders({
      content: `- [Blog]([PLACEHOLDER])\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("placeholder-leak");
  });

  test("EXCEPTION 2 — [PLACEHOLDER] also fails in a fragment", () => {
    const failures = checkPlaceholders({
      content: `- [Blog]([PLACEHOLDER])\n`,
      file: "docs/fragments/25-what-im-doing.md",
      section: "what-im-doing",
    });
    expect(rulesOf(failures)).toContain("placeholder-leak");
  });
});

describe("link well-formedness", () => {
  test("valid links pass", () => {
    const content = `- [vivera](https://github.com/belajarcarabelajar/vivera)\nBare: https://belajarcarabelajar.com\n`;
    expect(checkLinks({ content, file: "README.md", section: "all" })).toEqual([]);
  });

  test("undefined / null / TODO targets fail", () => {
    for (const bad of ["undefined", "null", "TODO", ""]) {
      const failures = checkLinks({
        content: `- [broken](${bad})\n`,
        file: "README.md",
        section: "all",
      });
      expect(rulesOf(failures)).toContain("malformed-link");
    }
  });

  test("a target containing a space fails", () => {
    const failures = checkLinks({
      content: `- [broken](https://belajarcarabelajar.com/my page)\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("malformed-link");
  });
});

describe("github repo links", () => {
  test("allowlisted public repos pass", () => {
    const names = ["vivera", "dawnbook", "adaptiva", "snipset-cli"];
    for (const name of names) {
      expect(KNOWN_PUBLIC_REPOS.has(name)).toBe(true);
      const failures = checkGitHubRepoLinks({
        content: `- [${name}](https://github.com/belajarcarabelajar/${name})\n`,
        file: "README.md",
        section: "all",
      });
      expect(failures).toEqual([]);
    }
  });

  test("an unknown repo name fails", () => {
    const failures = checkGitHubRepoLinks({
      content: `- [mystery](https://github.com/belajarcarabelajar/totally-not-a-real-repo)\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("repo-not-allowlisted");
    expect(failures[0].message).toContain("totally-not-a-real-repo");
  });

  test("a private repo without a website fails", () => {
    const failures = checkGitHubRepoLinks({
      content: `- [vault](https://github.com/belajarcarabelajar/obsidian-vault)\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("repo-private-no-website");
    expect(PRIVATE_REPOS_WITHOUT_WEBSITE.has("obsidian-vault")).toBe(true);
  });

  test("the winget-pkgs fork fails on its own rule", () => {
    const failures = checkGitHubRepoLinks({
      content: `- [winget](https://github.com/belajarcarabelajar/winget-pkgs)\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("repo-fork-excluded");
    expect(FORBIDDEN_REPO_NAMES.has("winget-pkgs")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* T3 — regression tests for the corrected repo-name sets              */
/* ------------------------------------------------------------------ */

/** Verified homepages: `gh api repos/belajarcarabelajar/<name>` 2026-10-04. */
const PRIVATE_WEBSITES = {
  snipset: "https://snipset.belajarcarabelajar.com",
  satset: "https://satset.belajarcarabelajar.com",
  ratecard: "https://ratecard.belajarcarabelajar.com",
  "flash-course": "https://course.belajarcarabelajar.com/",
  "belajarcarabelajar-app": "https://app.belajarcarabelajar.com/",
};

describe("T3 — private-without-website denylist corrections", () => {
  test("Todoist is DENIED as a github.com link (regression: it was missing from the denylist entirely)", () => {
    // Before the fix `Todoist` was in no set at all, so it was denied only by
    // the unknown-name fallback (`repo-not-allowlisted`) — for the wrong
    // reason. It must be denied as a *known private* repo.
    expect(PRIVATE_REPOS_WITHOUT_WEBSITE.has("todoist")).toBe(true);
    const failures = checkGitHubRepoLinks({
      content: `- [Todoist](https://github.com/belajarcarabelajar/Todoist)\n`,
      file: "README.md",
      section: "all",
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(rulesOf(failures)).toContain("repo-private-no-website");
    expect(rulesOf(failures)).not.toContain("repo-not-allowlisted");
  });

  test("berdu is DENIED as a github.com link", () => {
    expect(PRIVATE_REPOS_WITHOUT_WEBSITE.has("berdu")).toBe(true);
    const failures = checkGitHubRepoLinks({
      content: `- [berdu](https://github.com/belajarcarabelajar/berdu)\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("repo-private-no-website");
  });

  test("terminal-log-intelligence is DENIED as a github.com link", () => {
    expect(PRIVATE_REPOS_WITHOUT_WEBSITE.has("terminal-log-intelligence")).toBe(true);
    const failures = checkGitHubRepoLinks({
      content: `- [tli](https://github.com/belajarcarabelajar/terminal-log-intelligence)\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("repo-private-no-website");
  });

  test("anti-regression: berdu and terminal-log-intelligence are NOT in PRIVATE_REPOS_WITH_WEBSITE", () => {
    // A previous agent placed both in the with-website set on a guess, behind
    // the fabricated comment `defensive: verified below`. They are private with
    // no homepage. This is the guard that stops the guess coming back.
    expect(PRIVATE_REPOS_WITH_WEBSITE.has("berdu")).toBe(false);
    expect(PRIVATE_REPOS_WITH_WEBSITE.has("terminal-log-intelligence")).toBe(false);
    expect([...PRIVATE_REPOS_WITH_WEBSITE].some((n) => /verified|defensive/i.test(n))).toBe(false);
  });
});

describe("T3 — private-with-website set", () => {
  for (const [name, website] of Object.entries(PRIVATE_WEBSITES)) {
    test(`"${name}" is rejected as a github.com link and accepted as a website link`, () => {
      expect(PRIVATE_REPOS_WITH_WEBSITE.has(name)).toBe(true);

      const asGithub = checkGitHubRepoLinks({
        content: `- [x](https://github.com/belajarcarabelajar/${name})\n`,
        file: "README.md",
        section: "all",
      });
      expect(asGithub.length).toBeGreaterThan(0);
      expect(rulesOf(asGithub)).toContain("repo-private-with-website");

      const asWebsite = checkGitHubRepoLinks({
        content: `- [x](${website})\n`,
        file: "README.md",
        section: "all",
      });
      expect(asWebsite).toEqual([]);
    });
  }

  test("with-website set holds exactly the 5 repos with a live homepage", () => {
    expect([...PRIVATE_REPOS_WITH_WEBSITE].sort()).toEqual(Object.keys(PRIVATE_WEBSITES).sort());
  });
});

describe("T3 — set integrity", () => {
  test("denylist is exactly 24, with-website exactly 5, and the two are disjoint", () => {
    expect(PRIVATE_REPOS_WITHOUT_WEBSITE.size).toBe(24);
    expect(PRIVATE_REPOS_WITH_WEBSITE.size).toBe(5);
    const overlap = [...PRIVATE_REPOS_WITHOUT_WEBSITE].filter((n) =>
      PRIVATE_REPOS_WITH_WEBSITE.has(n),
    );
    expect(overlap).toEqual([]);
  });

  test("all 24 denylisted names are lowercase-unique so the lowercase lookup cannot collide", () => {
    const lowered = [...PRIVATE_REPOS_WITHOUT_WEBSITE].map((n) => n.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
    // The validator lowercases before lookup, so the stored form must already
    // be the lowercase form for the lookup to be reachable at all.
    for (const name of PRIVATE_REPOS_WITHOUT_WEBSITE) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  test("the capitalised GitHub names Todoist and Sessionist are denied through the lowercase lookup", () => {
    for (const [githubCase, stored] of [
      ["Todoist", "todoist"],
      ["Sessionist", "sessionist"],
    ]) {
      expect(PRIVATE_REPOS_WITHOUT_WEBSITE.has(stored)).toBe(true);
      const failures = checkGitHubRepoLinks({
        content: `- [x](https://github.com/belajarcarabelajar/${githubCase})\n`,
        file: "README.md",
        section: "all",
      });
      expect(rulesOf(failures)).toContain("repo-private-no-website");
    }
  });
});

describe("images and badges", () => {
  test("valid image and badge pass", () => {
    const failures = checkImagesAndBadges({
      content: `![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge)\n`,
      file: "README.md",
      section: "all",
    });
    expect(failures).toEqual([]);
  });

  test("empty alt fails", () => {
    const failures = checkImagesAndBadges({
      content: `![](https://img.shields.io/badge/Rust-000000)\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("image-alt-empty");
  });

  test("non-http image url fails", () => {
    const failures = checkImagesAndBadges({
      content: `![Rust](./assets/rust.svg)\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("image-url-invalid");
  });

  test("empty shields label fails", () => {
    const failures = checkImagesAndBadges({
      content: `<img src="https://img.shields.io/badge/-000000?style=flat-square" alt="Build" />\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("badge-segment-empty");
  });

  test("empty shields message fails", () => {
    const failures = checkImagesAndBadges({
      content: `<img src="https://img.shields.io/badge/Rust--000000?style=flat-square" alt="Rust" />\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("badge-segment-empty");
  });

  test("empty shields query label fails", () => {
    const failures = checkImagesAndBadges({
      content: `<img src="https://img.shields.io/static/v1?label=&message=hi&color=blue" alt="hi" />\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("badge-segment-empty");
  });
});

describe("stats presence", () => {
  test("present passes", () => {
    expect(checkStatsPresence({ content: VALID_STATS_BLOCK, file: "README.md", section: "all" })).toEqual(
      [],
    );
  });

  test("missing contribution graph fails", () => {
    const content = `<img src="https://github-stats-extended.vercel.app/api?username=belajarcarabelajar" alt="GitHub Stats" />`;
    const failures = checkStatsPresence({ content, file: "README.md", section: "all" });
    expect(rulesOf(failures)).toContain("missing-contribution-graph");
  });

  test("missing github stats fails", () => {
    const content = `<img src="https://gitlyy.vercel.app/api/contribution?username=belajarcarabelajar" alt="Activity" />`;
    const failures = checkStatsPresence({ content, file: "README.md", section: "all" });
    expect(rulesOf(failures)).toContain("missing-github-stats");
  });
});

describe("validateContent / validateFile", () => {
  test("validateContent returns no failures for a valid README", () => {
    const failures = validateContent({
      content: validReadme(),
      file: "README.md",
      section: "all",
    });
    expect(failures).toEqual([]);
  });

  test("validateFile reads a fixture from disk and infers the section", () => {
    const abs = fixture("docs/fragments/25-what-im-doing.md", `## 🔨 What I'm Doing\n\nShipping.\n`);
    const failures = validateFile({ file: abs, repoRoot: REPO_ROOT });
    expect(failures).toEqual([]);
  });

  test("validateFile reports a missing file instead of throwing", () => {
    const failures = validateFile({
      file: join(tmpRoot, "does-not-exist.md"),
      repoRoot: REPO_ROOT,
    });
    expect(rulesOf(failures)).toContain("target-missing");
  });
});

describe("eligibility rules (--rules)", () => {
  test("denylist is loaded and includes the known private repos", () => {
    for (const name of ["obsidian-vault", "arch-config-backup", "fasttrack", "berdu", "9router"]) {
      expect(PRIVATE_REPOS_WITHOUT_WEBSITE.has(name)).toBe(true);
    }
    expect(PRIVATE_REPOS_WITHOUT_WEBSITE.has("vivera")).toBe(false);
  });

  test("checkEligibilityRules passes on public-repo links only", () => {
    const failures = checkEligibilityRules({
      content: `- [vivera](https://github.com/belajarcarabelajar/vivera)\n- [Snipset](https://snipset.belajarcarabelajar.com)\n`,
      file: "README.md",
      section: "all",
    });
    expect(failures).toEqual([]);
  });

  test("a denylisted name that is also an ordinary product word is not a violation in prose", () => {
    // Measured false positive: "Cloudflare Workers" is legitimate prose.
    const failures = checkEligibilityRules({
      content: `Focused on React, Cloudflare Workers, and Rust.\n`,
      file: "README.md",
      section: "all",
    });
    expect(failures).toEqual([]);
  });

  test("a denylisted name used only as a shields.io logo param is not a violation", () => {
    // Second measured false positive: `logo=cloudflare` on a badge URL.
    const failures = checkEligibilityRules({
      content: `<img src="https://img.shields.io/badge/Cloudflare_Workers-F38020?style=for-the-badge&logo=cloudflare" alt="Cloudflare Workers" />\n`,
      file: "README.md",
      section: "all",
    });
    expect(failures).toEqual([]);
  });

  test("a slug-shaped denylisted name is still rejected even without a github link", () => {
    const failures = checkEligibilityRules({
      content: `I also maintain obsidian-vault in private.\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("repo-private-no-website");
  });

  test("checkEligibilityRules fails on a private-without-website repo link", () => {
    const failures = checkEligibilityRules({
      content: `- [vault](https://github.com/belajarcarabelajar/obsidian-vault)\n`,
      file: "README.md",
      section: "all",
    });
    expect(rulesOf(failures)).toContain("repo-private-no-website");
  });

  test("--rules exits 0 on a clean target", () => {
    const abs = fixture(
      "rules-ok.md",
      `- [vivera](https://github.com/belajarcarabelajar/vivera)\n`,
    );
    const res = runCli(["--rules", "--target", abs]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("obsidian-vault");
  });

  test("--rules exits 1 on a denylisted repo and names the file", () => {
    const abs = fixture(
      "rules-bad.md",
      `- [vault](https://github.com/belajarcarabelajar/obsidian-vault)\n`,
    );
    const res = runCli(["--rules", "--target", abs]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("rules-bad.md");
    expect(res.out).toContain("obsidian-vault");
  });
});

describe("T3 — eligibility classification (--rules asserts the decision)", () => {
  test("classifyRepoLink maps every linked repo to PUBLIC, PRIVATE_WITH_WEBSITE or DENIED", () => {
    const { classifyRepoLink } = verifier;
    expect(typeof classifyRepoLink).toBe("function");
    expect(classifyRepoLink("vivera")).toBe("PUBLIC");
    expect(classifyRepoLink("snipset-cli")).toBe("PUBLIC");
    expect(classifyRepoLink("snipset")).toBe("PRIVATE_WITH_WEBSITE");
    expect(classifyRepoLink("satset")).toBe("PRIVATE_WITH_WEBSITE");
    expect(classifyRepoLink("berdu")).toBe("DENIED");
    expect(classifyRepoLink("obsidian-vault")).toBe("DENIED");
    expect(classifyRepoLink("winget-pkgs")).toBe("DENIED");
    expect(classifyRepoLink("totally-not-a-real-repo")).toBe("DENIED");
  });

  test("classifyRepoLink is case-insensitive, matching the lowercase lookup", () => {
    const { classifyRepoLink } = verifier;
    expect(classifyRepoLink("Todoist")).toBe("DENIED");
    expect(classifyRepoLink("Sessionist")).toBe("DENIED");
    expect(classifyRepoLink("Snipset")).toBe("PRIVATE_WITH_WEBSITE");
    expect(classifyRepoLink("Vivera")).toBe("PUBLIC");
    // Casing alone must not change the decision: "Sipset" is not the repo
    // "snipset", so it is unaccounted for and therefore DENIED.
    expect(classifyRepoLink("Sipset")).toBe("DENIED");
  });

  test("classification covers every github.com repo link in the target, not just the bad ones", () => {
    const { classifyRepoLinks } = verifier;
    expect(typeof classifyRepoLinks).toBe("function");
    const classified = classifyRepoLinks(
      `- [vivera](https://github.com/belajarcarabelajar/vivera)\n` +
        `- [Snipset](https://github.com/belajarcarabelajar/snipset)\n` +
        `- [berdu](https://github.com/belajarcarabelajar/berdu)\n`,
    );
    expect(classified.map((c) => [c.name, c.decision])).toEqual([
      ["vivera", "PUBLIC"],
      ["snipset", "PRIVATE_WITH_WEBSITE"],
      ["berdu", "DENIED"],
    ]);
    for (const c of classified) {
      expect(typeof c.line).toBe("number");
      expect(c.file).toBeTruthy();
    }
  });

  test("a website link to a private-with-website repo produces no github classification at all", () => {
    const { classifyRepoLinks } = verifier;
    const classified = classifyRepoLinks(`- [Snipset](https://snipset.belajarcarabelajar.com)\n`);
    expect(classified).toEqual([]);
  });

  test("--rules exits 1 and names the file when a link is not PUBLIC", () => {
    const abs = fixture(
      "26-projects-flagship.md",
      `- [Snipset](https://github.com/belajarcarabelajar/snipset)\n`,
    );
    const res = runCli(["--rules", "--target", abs]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("26-projects-flagship.md");
    expect(res.out).toContain("repo-private-with-website");
  });

  test("--rules reports the three classification counts and exits 0 when clean", () => {
    const abs = fixture(
      "27-projects-oss.md",
      `- [vivera](https://github.com/belajarcarabelajar/vivera)\n` +
        `- [adaptiva](https://github.com/belajarcarabelajar/adaptiva)\n`,
    );
    const res = runCli(["--rules", "--target", abs]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/classification: 2 PUBLIC, 0 PRIVATE_WITH_WEBSITE, 0 DENIED/);
  });

  test("--rules reports a non-zero DENIED count on a failing target", () => {
    const abs = fixture(
      "28-projects-ai.md",
      `- [vivera](https://github.com/belajarcarabelajar/vivera)\n` +
        `- [Todoist](https://github.com/belajarcarabelajar/Todoist)\n`,
    );
    const res = runCli(["--rules", "--target", abs]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/classification: 1 PUBLIC, 0 PRIVATE_WITH_WEBSITE, 1 DENIED/);
  });

  test("--rules honours --target rather than silently falling back to README.md", () => {
    // A target with a bad link must fail even though the repo's own README.md
    // is clean. If --target were ignored, this would exit 0.
    const clean = runCli(["--rules", "--root", REPO_ROOT]);
    expect(clean.code).toBe(0);

    const abs = fixture("29-projects-tools.md", `- [x](https://github.com/belajarcarabelajar/berdu)\n`);
    const res = runCli(["--rules", "--target", abs, "--root", REPO_ROOT]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("29-projects-tools.md");
  });
});

describe("target glob", () => {
  test("expandGlob resolves a shell-style pattern against the repo root", () => {
    const dir = fixture("frag/26-projects-flagship.md", "x\n");
    const root = dirname(dirname(dir));
    const matches = expandGlob("frag/2*.md", root);
    expect(matches.map((m) => m.split("/").pop())).toContain("26-projects-flagship.md");
  });

  test("expandGlob accepts an already-expanded literal path", () => {
    const abs = fixture("frag/27-projects-oss.md", "x\n");
    expect(expandGlob(abs, tmpRoot)).toEqual([abs]);
  });

  test("--target-glob validates every matching fragment and fails when one is bad", () => {
    const root = join(tmpRoot, `glob${fixtureSeq++}`);
    mkdirSync(join(root, "docs/fragments"), { recursive: true });
    writeFileSync(
      join(root, "docs/fragments/26-projects-flagship.md"),
      `## 🚀 Flagship Products\n\n- [Snipset](https://snipset.belajarcarabelajar.com)\n`,
    );
    writeFileSync(
      join(root, "docs/fragments/27-projects-oss.md"),
      `## 🐙 Open Source\n\nTrusted by 500K+ learners.\n`,
    );
    writeFileSync(
      join(root, "docs/fragments/28-projects-ai.md"),
      `## 🤖 AI & Automation\n\n- [snipset-cli](https://github.com/belajarcarabelajar/snipset-cli)\n`,
    );

    const bad = runCli(["--target-glob", "docs/fragments/2*.md", "--root", root]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("27-projects-oss.md");
    expect(bad.out).not.toContain("26-projects-flagship.md — FAIL");
    expect(bad.out).not.toContain("28-projects-ai.md — FAIL");

    writeFileSync(
      join(root, "docs/fragments/27-projects-oss.md"),
      `## 🐙 Open Source\n\n- [vivera](https://github.com/belajarcarabelajar/vivera)\n`,
    );
    const good = runCli(["--target-glob", "docs/fragments/2*.md", "--root", root]);
    expect(good.code).toBe(0);
  });

  test("--target-glob validates shell-expanded literal paths too", () => {
    const root = join(tmpRoot, `globlit${fixtureSeq++}`);
    mkdirSync(join(root, "docs/fragments"), { recursive: true });
    const a = join(root, "docs/fragments/30-connect.md");
    const b = join(root, "docs/fragments/38-philosophy-facts.md");
    writeFileSync(a, `## 🔌 Connect\n\n- [belajarcarabelajar.com](https://belajarcarabelajar.com)\n`);
    writeFileSync(b, `### Philosophy\n\n⭐ 42 stars of philosophy\n`);

    const res = runCli(["--target-glob", a, b, "--root", root]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("38-philosophy-facts.md");
    expect(res.out).not.toContain("30-connect.md — FAIL");
  });

  test("--target-glob with no match fails", () => {
    const res = runCli(["--target-glob", "docs/fragments/9*.md", "--root", tmpRoot]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("glob-no-match");
  });
});

describe("cli surface", () => {
  test("--section with --target validates one file and exits 0", () => {
    const abs = fixture("docs/PROFILE-README.template.md", `## Connect\n\n- [Email](mailto:[PLACEHOLDER])\n`);
    const res = runCli(["--section", "template", "--target", abs]);
    expect(res.code).toBe(0);
  });

  test("--section template rejects a broken link", () => {
    const abs = fixture(
      "docs/PROFILE-README.template.md",
      `## Connect\n\n- [Email](undefined)\n`,
    );
    const res = runCli(["--section", "template", "--target", abs]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("malformed-link");
  });

  test("--target on README.md runs the full offline check set", () => {
    const abs = fixture("README.md", validReadme());
    const res = runCli(["--target", abs]);
    expect(res.code).toBe(0);
  });

  test("--target on a README missing a section exits 1", () => {
    const abs = fixture(
      "README.md",
      validReadme().replace(`<!-- section: connect -->\n## 🔌 Connect\n\n- [belajarcarabelajar.com](https://belajarcarabelajar.com)\n\n`, ``),
    );
    const res = runCli(["--target", abs]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("section-missing");
  });

  test("every failure line names file, section and reason", () => {
    const abs = fixture("README.md", `Trusted by 500K+ learners.\n`);
    const res = runCli(["--target", abs]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/README\.md — \[all\] forbidden-figure: .+/);
  });

  test("main() resolves to an exit code and does not call process.exit itself", async () => {
    // main() writes PASS/FAIL lines to process.stdout. Intercept it so the
    // validator's own output does not leak into `bun test` output and read as
    // failures (F2, 2026-10-04). The captured text is still asserted on.
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk) => {
      captured += String(chunk);
      return true;
    });
    try {
      const abs = fixture("README.md", validReadme());
      expect(await main(["--target", abs], { repoRoot: REPO_ROOT })).toBe(0);
      expect(captured).toContain("PASS");
      captured = "";
      const bad = fixture("README2.md", `- [x](undefined)\n`);
      expect(await main(["--target", bad], { repoRoot: REPO_ROOT })).toBe(1);
      expect(captured).toMatch(/FAIL .* malformed-link/);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test("unknown flags are rejected", () => {
    const res = runCli(["--nope"]);
    expect(res.code).toBe(2);
    expect(res.out).toContain("unknown flag");
  });
});

/* Parent audit 2026-10-04: suffixed placeholder tokens must be caught, not just
   the bare `[PLACEHOLDER]`. Added after the wave-2 audit found the bare-token
   regex let [PLACEHOLDER-NAME] through into a shipping README. */
describe("parent audit — suffixed placeholder leakage", () => {
  const { checkPlaceholders } = verifier;
  const cases = [
    "[PLACEHOLDER]",
    "[PLACEHOLDER-NAME]",
    "[PLACEHOLDER-ROLE]",
    "[PLACEHOLDER-URL]",
    "[PLACEHOLDER-CITY]",
    "[PLACEHOLDER-ANYTHING-GOES]",
  ];
  for (const token of cases) {
    test(`${token} is reported as placeholder-leak`, () => {
      const failures = checkPlaceholders({
        content: `# Hi\n\nSome prose.\n\n${token}\n`,
        file: "README.md",
        section: "identity",
      });
      expect(failures.length).toBe(1);
      expect(failures[0].rule).toBe("placeholder-leak");
      expect(failures[0].message).toContain(token);
    });
  }

  test("a real README with no placeholder passes", () => {
    const failures = checkPlaceholders({
      content: "# Hi, I'm Iwan\n\nNothing to replace here.\n",
      file: "README.md",
      section: "identity",
    });
    expect(failures).toEqual([]);
  });

  test("the template file is still exempt", () => {
    const failures = checkPlaceholders({
      content: "# Hi, I'm [PLACEHOLDER-NAME]\n",
      file: "docs/PROFILE-README.template.md",
      section: "template",
    });
    expect(failures).toEqual([]);
  });
});

describe("parent audit 2026-10-04 — gitlyy contribution graph", () => {
  test("gitlyy contribution URL satisfies the contribution-graph requirement", () => {
    const content = `<img src="https://gitlyy.vercel.app/api/contribution?username=belajarcarabelajar&hide_border=true" alt="GitHub Activity Graph" /><img src="https://github-stats-extended.vercel.app/api?username=belajarcarabelajar" alt="GitHub Stats" />`;
    expect(checkStatsPresence({ content, file: "README.md", section: "all" })).toEqual([]);
  });
});

/* Parent audit — HTML block swallowing What I'm Doing (screenshot 2026-10-04).
   A `<p>...</p>` line followed directly by Markdown renders the Markdown as
   literal text, because an HTML block only ends at a blank line. */
describe("parent audit — html block boundaries", () => {
  const run = (content, section = "all") =>
    checkHtmlBoundaries({ content, file: "README.md", section });

  test("html block line followed directly by a heading fails", () => {
    const failures = run(`<p align="center"><img src="https://example.com/a.png" alt="A" /></p>\n## What I'm Doing\n`);
    expect(rulesOf(failures)).toContain("html-block-blank-line");
    expect(failures[0].message).toContain("line 2");
  });

  test("html block line followed by a blank line passes", () => {
    expect(run(`<p align="center"><img src="https://example.com/a.png" alt="A" /></p>\n\n## What I'm Doing\n`)).toEqual([]);
  });

  test("html block line followed by another html line passes", () => {
    expect(run(`<p align="center">x</p>\n<table><tr><td>y</td></tr></table>\n\n## Next\n`)).toEqual([]);
  });

  test("complete single-line comment followed by a heading passes", () => {
    expect(run(`<!-- section: what-im-doing -->\n## What I'm Doing\n`)).toEqual([]);
  });

  test("html block run through a comment into a heading fails", () => {
    const failures = run(`<table><tr><td>x</td></tr></table>\n<!-- section: what-im-doing -->\n## What I'm Doing\n`);
    expect(rulesOf(failures)).toContain("html-block-blank-line");
    expect(failures[0].message).toContain("line 3");
  });

  test("details summary followed directly by a list fails", () => {
    const failures = run(`<details><summary>Random Facts</summary>\n- item one\n</details>\n`);
    expect(rulesOf(failures)).toContain("html-block-blank-line");
  });

  test("the template section is exempt", () => {
    expect(
      checkHtmlBoundaries({ content: `<p>x</p>\n## Heading\n`, file: "docs/PROFILE-README.template.md", section: "template" }),
    ).toEqual([]);
  });
});
