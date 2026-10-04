#!/usr/bin/env bun
/**
 * verify-profile.mjs — the single gate for the GitHub profile README.
 *
 * Owned by Task T1. Every later task (T2..T7) reports through this script.
 * Exit 0 = pass, exit 1 = validation failure, exit 2 = usage error.
 *
 * CLI:
 *   bun scripts/verify-profile.mjs --section <name>
 *   bun scripts/verify-profile.mjs --section template --target docs/PROFILE-README.template.md
 *   bun scripts/verify-profile.mjs --target <file>
 *   bun scripts/verify-profile.mjs --target-glob <pattern|path...>
 *   bun scripts/verify-profile.mjs --rules
 *   bun scripts/verify-profile.mjs --links
 *   bun scripts/verify-profile.mjs --all [--links]
 *
 * Options: --root <dir>  (repo root override; default is the parent of scripts/)
 *          --help        (usage)
 *
 * Design notes
 * ------------
 * - Section detection is driven by two signals, in priority order:
 *   1. an explicit `<!-- section: <name> -->` marker,
 *   2. the `##`/`###` heading text matched against the section's keywords.
 *   T7 assembles README.md from the fragments, so markers are the reliable
 *   channel; the heading matcher keeps a hand-written README verifiable.
 * - Every failure carries { file, section, rule, message } and every failure
 *   line is printed as `<file> — [<section>] <rule>: <message>`.
 * - `--all` never touches the network. `--links` is the only network mode.
 */

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ */
/* Section registry                                                    */
/* ------------------------------------------------------------------ */

export const SECTION_REGISTRY = [
  { prefix: "10", filename: "10-identity.md", section: "identity", heading: "identity", keywords: ["identity", "hi there", "hello", "whoami", "who am i", "about me"] },
  { prefix: "15", filename: "15-badges.md", section: "badges", heading: "badges", keywords: ["badges", "stack", "toolbox"] },
  { prefix: "20", filename: "20-starthere.md", section: "starthere", heading: "start here", keywords: ["start here", "getting started", "start"] },
  { prefix: "21", filename: "21-activity.md", section: "activity", heading: "activity", keywords: ["activity", "contribution", "contributions", "stats"] },
  { prefix: "25", filename: "25-what-im-doing.md", section: "what-im-doing", heading: "what i'm doing", keywords: ["what i'm doing", "what im doing", "currently", "now", "these days"] },
  { prefix: "26", filename: "26-projects-flagship.md", section: "projects-flagship", heading: "flagship products", keywords: ["flagship", "flagship products", "products"] },
  { prefix: "27", filename: "27-projects-oss.md", section: "projects-oss", heading: "open source", keywords: ["open source", "oss"] },
  { prefix: "28", filename: "28-projects-ai.md", section: "projects-ai", heading: "ai & automation", keywords: ["ai", "ai & automation", "ai and automation", "automation", "machine learning", "agents"] },
  { prefix: "29", filename: "29-projects-tools.md", section: "projects-tools", heading: "tools & distribution", keywords: ["tools", "tools & distribution", "distribution"] },
  { prefix: "30", filename: "30-connect.md", section: "connect", heading: "connect", keywords: ["connect", "contact", "say hello", "find me", "elsewhere", "social"] },
  { prefix: "38", filename: "38-philosophy-facts.md", section: "philosophy-facts", heading: "philosophy", keywords: ["philosophy", "random facts", "facts", "principles", "thinking"] },
  { prefix: null, filename: "README.md", section: "all", heading: null, keywords: [] },
  { prefix: null, filename: "PROFILE-README.template.md", section: "template", heading: null, keywords: [] },
];

/** The FINAL assembled order required in README.md. */
export const REQUIRED_SECTION_ORDER = [
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
];

/** Section inferred from a filename (basename or path). */
export function sectionForFilename(filename) {
  const base = basename(filename);
  for (const entry of SECTION_REGISTRY) {
    if (base === entry.filename) return entry.section;
  }
  // `10-identity.md` style, matched by prefix even if the registry drifts.
  const m = /^(\d+)-(.+)\.md$/.exec(base);
  if (m) {
    const known = SECTION_REGISTRY.find((e) => e.prefix === m[1]);
    if (known) return known.section;
    return m[2];
  }
  if (/template/i.test(base)) return "template";
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Repo policy data (T3 extends checkEligibilityRules, not this data)   */
/* ------------------------------------------------------------------ */

/** Public repos, from `gh api users/belajarcarabelajar/repos?type=public` 2026-10-04. */
export const KNOWN_PUBLIC_REPOS = new Set([
  "adaptiva",
  "belajarcarabelajar",
  "contoh-tts",
  "dawnbook",
  "jatimetri",
  "rasalytics",
  "satset-obsidian-sync",
  "scoop-snipset",
  "snipset-assets",
  "snipset-cli",
  "time-capsule",
  "vivera",
]);

/**
 * Private repos with no live public website — must never be linked at all.
 * Names are stored LOWERCASE: the GitHub API reports `Sessionist` and
 * `Todoist` capitalised, but `repoLinkFailures()` lowercases before lookup,
 * so the stored form has to be the lowercased one to be reachable.
 * Verified 2026-10-04 via `gh api repos/belajarcarabelajar/<name>` → `homepage` is null.
 */
export const PRIVATE_REPOS_WITHOUT_WEBSITE = new Set([
  "obsidian-vault",
  "arch-config-backup",
  "fasttrack",
  "terminal-log-intelligence",
  "ani-cli-indo",
  "cloudflare",
  "vps-infra",
  "berdu",
  "wsl-config-backup",
  "9router",
  "sessionist",
  "todoist",
  "shanice-margaretha",
  "lp-bcbacademy-studyhacks",
  "fasttrackai",
  "private-class",
  "digital-presence",
  "satset-emulator",
  "mentoring-landing-page",
  "bcb-claude-config",
  "money-tracker",
  "satset-notetaking-v2",
  "perplexi-ninja-toolkit",
  "ladang-impian-frontend",
]);

/**
 * Rule: a private repo that HAS a live website is linked by its WEBSITE url
 * only. A `github.com/belajarcarabelajar/<name>` link to it must be rejected
 * (rule `repo-private-with-website`) because it 404s for every visitor.
 * Verified 2026-10-04 via `gh api repos/belajarcarabelajar/<name>` → `private: true`,
 * `homepage` as recorded on each line below.
 */
export const PRIVATE_REPOS_WITH_WEBSITE = new Set([
  "snipset", // https://snipset.belajarcarabelajar.com
  "satset", // https://satset.belajarcarabelajar.com
  "ratecard", // https://ratecard.belajarcarabelajar.com
  "flash-course", // https://course.belajarcarabelajar.com/
  "belajarcarabelajar-app", // https://app.belajarcarabelajar.com/
]);

/** Excluded on grounds other than visibility (forks). */
export const FORBIDDEN_REPO_NAMES = new Set(["winget-pkgs"]);

const GITHUB_REPO_RE = /https?:\/\/github\.com\/belajarcarabelajar\/([A-Za-z0-9._-]+)/g;

/** Every repo name linked as `github.com/belajarcarabelajar/<name>` in order. */
export function extractRepoNames(content) {
  const out = [];
  for (const m of content.matchAll(GITHUB_REPO_RE)) out.push(m[1]);
  return out;
}

/** As `extractRepoNames`, but with the offset/line needed to report a link. */
export function extractRepoLinks(content) {
  const out = [];
  for (const m of content.matchAll(GITHUB_REPO_RE)) {
    out.push({ name: m[1], index: m.index, line: lineAt(content, m.index) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Decision classification (T3)                                        */
/* ------------------------------------------------------------------ */

export const DECISIONS = ["PUBLIC", "PRIVATE_WITH_WEBSITE", "DENIED"];

/**
 * The single decision rule, in one place, so `--rules` reports exactly what
 * `repoLinkFailures()` enforces:
 *   - a fork is DENIED (excluded on grounds other than visibility),
 *   - private with no website is DENIED (may never be linked at all),
 *   - private with a website is PRIVATE_WITH_WEBSITE — website url only,
 *   - an allowlisted public repo is PUBLIC,
 *   - anything unaccounted for is DENIED, never silently allowed.
 *
 * Order matters: the two private sets are disjoint (asserted by test), so a
 * name can never be both DENIED and PRIVATE_WITH_WEBSITE.
 */
export function classifyRepoLink(name) {
  const lower = String(name).toLowerCase();
  if (FORBIDDEN_REPO_NAMES.has(lower)) return "DENIED";
  if (PRIVATE_REPOS_WITHOUT_WEBSITE.has(lower)) return "DENIED";
  if (PRIVATE_REPOS_WITH_WEBSITE.has(lower)) return "PRIVATE_WITH_WEBSITE";
  if (KNOWN_PUBLIC_REPOS.has(lower)) return "PUBLIC";
  return "DENIED";
}

/**
 * Classify every `github.com/belajarcarabelajar/<name>` link in `content`.
 * Website links are deliberately absent — they are the correct way to link a
 * private repo that has one, so they carry no decision to assert.
 */
export function classifyRepoLinks(content, { file = "README.md" } = {}) {
  return extractRepoLinks(content).map((l) => ({
    name: l.name,
    line: l.line,
    file,
    decision: classifyRepoLink(l.name),
  }));
}

/* ------------------------------------------------------------------ */
/* Forbidden audience figures — a hard human rule, do not weaken         */
/* ------------------------------------------------------------------ */

export const FORBIDDEN_FIGURE_PATTERNS = [
  { name: "audience-500K", re: /500\s?K/i },
  { name: "audience-500000", re: /500,000/i },
  { name: "audience-302K", re: /302\s?K/i },
  { name: "audience-130K", re: /130\s?K/i },
  { name: "audience-113.8K", re: /113\.8\s?K/i },
  { name: "audience-140K", re: /140(\.1)?\s?K/i },
  { name: "audience-10M-plus", re: /10M\+/i },
  { name: "followers-word", re: /followers/i },
  { name: "audience-K-learners", re: /\d+\s?K\s?learners/i },
  { name: "audience-138K", re: /138K/i },
  { name: "audience-9.5K", re: /\b9\.5K\b/i },
  { name: "star-count-parens", re: /\(\d+(\.\d+)?k?\+?\s*stars\)/i },
  { name: "star-count-emoji", re: /⭐\s*\d+/ },
];

/** GitHub Stats card image URLs get a narrow allowance for `username=` params. */
const STATS_CARD_URL_RE = /https?:\/\/github-stats-extended\.vercel\.app\/[^\s)"'<>]*/g;

const STATS_CARD_BAD_TOKENS = [
  /500\s?K/i,
  /500,000/i,
  /302\s?K/i,
  /130\s?K/i,
  /113\.8\s?K/i,
  /140(\.1)?\s?K/i,
  /10M\+/i,
  /followers/i,
  /\d+\s?K\s?learners/i,
  /138K/i,
  /\b9\.5K\b/i,
];

/* ------------------------------------------------------------------ */
/* Failure helper                                                      */
/* ------------------------------------------------------------------ */

function fail(file, section, rule, message, line) {
  const f = { file, section, rule, message };
  if (line !== undefined) f.line = line;
  return f;
}

/** Line number (1-based) of a character offset, or undefined. */
function lineAt(content, index) {
  if (index === undefined || index < 0) return undefined;
  return content.slice(0, index).split("\n").length;
}

/* ------------------------------------------------------------------ */
/* 1. Section presence and order                                       */
/* ------------------------------------------------------------------ */

/**
 * Detect section occurrences in document order.
 * Returns [{ section, index, line, via }].
 */
export function detectSections(content) {
  const found = [];

  // Signal 1: explicit markers.
  for (const m of content.matchAll(/<!--\s*section:\s*([a-z0-9][a-z0-9-]*)\s*-->/gi)) {
    found.push({ section: m[1].toLowerCase(), index: m.index, line: lineAt(content, m.index), via: "marker" });
  }

  // Signal 2: headings, only for sections with no marker yet.
  const marked = new Set(found.map((f) => f.section));
  const headingRe = /^(#{2,3})\s+(.+?)\s*$/gm;
  for (const m of content.matchAll(headingRe)) {
    const text = normaliseHeading(m[2]);
    for (const entry of SECTION_REGISTRY) {
      if (marked.has(entry.section)) break;
      if (entry.section === "all" || entry.section === "template") continue;
      if (entry.keywords.some((kw) => text.includes(nw(kw)))) {
        marked.add(entry.section);
        found.push({ section: entry.section, index: m.index, line: lineAt(content, m.index), via: "heading" });
        break;
      }
    }
  }

  found.sort((a, b) => a.index - b.index);
  return found;
}

function normaliseHeading(s) {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9'&+\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nw(s) {
  return s.toLowerCase();
}

export function checkSectionOrder({ content, file, section }) {
  if (section !== "all") return [];
  const failures = [];
  const detected = detectSections(content);

  const counts = new Map();
  for (const d of detected) counts.set(d.section, (counts.get(d.section) ?? 0) + 1);

  for (const name of REQUIRED_SECTION_ORDER) {
    const n = counts.get(name) ?? 0;
    if (n === 0) {
      failures.push(fail(file, name, "section-missing", `required section "${name}" is missing`));
    } else if (n > 1) {
      failures.push(
        fail(file, name, "section-duplicate", `section "${name}" appears ${n} times, expected exactly once`),
      );
    }
  }

  // Order: walk the detected sequence, ignoring sections outside the registry.
  const rank = new Map(REQUIRED_SECTION_ORDER.map((s, i) => [s, i]));
  const seq = detected.filter((d) => rank.has(d.section));
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1];
    const cur = seq[i];
    if (rank.get(cur.section) < rank.get(prev.section)) {
      failures.push(
        fail(
          file,
          cur.section,
          "section-order",
          `section "${cur.section}" appears after "${prev.section}", which breaks the required order (${REQUIRED_SECTION_ORDER.join(" → ")})`,
          cur.line,
        ),
      );
      break; // one order failure is enough to act on
    }
  }

  return failures;
}

/* ------------------------------------------------------------------ */
/* 2. Forbidden audience figures                                       */
/* ------------------------------------------------------------------ */

export function checkForbiddenFigures({ content, file, section }) {
  const failures = [];

  // EXCEPTION 1 (narrow): a stats-card URL may carry `username=`; only the
  // forbidden tokens themselves are still illegal inside it.
  const cardUrls = [];
  for (const m of content.matchAll(STATS_CARD_URL_RE)) {
    cardUrls.push({ url: m[0], index: m.index });
    for (const re of STATS_CARD_BAD_TOKENS) {
      const hit = re.exec(m[0]);
      if (hit) {
        failures.push(
          fail(
            file,
            section,
            "forbidden-figure",
            `forbidden audience figure "${hit[0]}" inside a GitHub Stats card URL (allowed: username= params only): ${m[0]}`,
            lineAt(content, m.index),
          ),
        );
      }
    }
  }

  // Mask the card URLs, then scan everything else with the full set.
  let masked = content;
  const spans = cardUrls.map((c) => [c.index, c.index + c.url.length]).sort((a, b) => b[0] - a[0]);
  for (const [start, end] of spans) masked = masked.slice(0, start) + " ".repeat(end - start) + masked.slice(end);

  for (const { name, re } of FORBIDDEN_FIGURE_PATTERNS) {
    for (const m of masked.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
      failures.push(
        fail(file, section, "forbidden-figure", `forbidden audience figure "${m[0]}" (pattern ${name})`, lineAt(masked, m.index)),
      );
    }
  }

  return failures;
}

/* ------------------------------------------------------------------ */
/* 3. Placeholder leakage                                              */
/* ------------------------------------------------------------------ */

/** EXCEPTION 2: the template file is *allowed* to carry placeholders. */
export function checkPlaceholders({ content, file, section }) {
  const failures = [];
  if (section === "template") return failures;
  // Parent audit 2026-10-04: the pattern was the bare token `[PLACEHOLDER]`, so the
  // suffixed forms the template actually uses — [PLACEHOLDER-NAME], [PLACEHOLDER-ROLE],
  // [PLACEHOLDER-URL] — sailed straight through into a shipping README. Match any
  // bracketed token beginning with PLACEHOLDER.
  const re = /\[PLACEHOLDER[^\]]*\]/g;
  for (const m of content.matchAll(re)) {
    failures.push(
      fail(file, section, "placeholder-leak", `${m[0]} must be replaced with real content before this file ships`, lineAt(content, m.index)),
    );
  }
  return failures;
}

/* ------------------------------------------------------------------ */
/* 4. Link well-formedness                                             */
/* ------------------------------------------------------------------ */

const BAD_TARGETS = new Set(["undefined", "null", "todo", "tbd", "n/a", "none", "-"]);

/** Markdown links/images, bare URLs and HTML href/src. */
export function extractLinks(content) {
  const links = [];

  // [text](target). Capture the whole parenthetical so that a target
  // containing a space is captured and can be reported, not skipped.
  for (const m of content.matchAll(/!?\[[^\]]*\]\(([^)]*)\)/g)) {
    links.push({ target: m[1], index: m.index, kind: "markdown" });
  }

  // <https://example.com>
  for (const m of content.matchAll(/<(https?:\/\/[^>\s]+)>/g)) {
    links.push({ target: m[1], index: m.index, kind: "autolink" });
  }

  // HTML href=/src=
  for (const m of content.matchAll(/\b(?:href|src)\s*=\s*["']([^"']*)["']/gi)) {
    links.push({ target: m[1], index: m.index, kind: "html" });
  }

  // Bare URLs, minus the ones already captured above.
  const claimed = new Set(links.map((l) => `${l.index}:${l.target}`));
  for (const m of content.matchAll(/https?:\/\/[^\s<>()[\]"']+/g)) {
    let target = m[0];
    while (target.endsWith(".")) target = target.slice(0, -1);
    const absolute = m.index + m[0].length - target.length;
    const dup = claimed.has(`${absolute}:${target}`);
    if (!dup) links.push({ target, index: absolute, kind: "bare" });
  }

  return links;
}

export function checkLinks({ content, file, section }) {
  const failures = [];
  const seen = new Set();

  for (const link of extractLinks(content)) {
    let raw = link.target;
    // `[a](url "title")` is legal markdown — strip the title, keep the target.
    const titled = /^(\S*)\s+["'(].*$/.exec(raw);
    if (titled) raw = titled[1];
    const target = decodeURIComponentSafe(raw).trim();

    if (target === "") {
      failures.push(fail(file, section, "malformed-link", `empty link target in ${link.kind} link`, lineAt(content, link.index)));
      continue;
    }
    if (BAD_TARGETS.has(target.toLowerCase())) {
      failures.push(
        fail(file, section, "malformed-link", `link target is literally "${raw}" — replace it with a real URL`, lineAt(content, link.index)),
      );
      continue;
    }
    if (/\s/.test(target) && link.kind === "markdown") {
      failures.push(
        fail(file, section, "malformed-link", `link target contains a space: "${raw}"`, lineAt(content, link.index)),
      );
      continue;
    }
    if ((link.kind === "markdown" || link.kind === "html" || link.kind === "bare" || link.kind === "autolink") && /^[a-z][a-z0-9+.-]*:/i.test(target)) {
      let scheme = target.slice(0, target.indexOf(":")).toLowerCase();
      if (scheme === "mailto") scheme = "mailto";
      const ok = new Set(["http", "https", "mailto", "tel"]);
      if (!ok.has(scheme)) {
        failures.push(
          fail(file, section, "malformed-link", `link target has an unusable scheme: "${raw}"`, lineAt(content, link.index)),
        );
        continue;
      }
    }
    const key = `${link.kind}|${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
  }

  return failures;
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/* ------------------------------------------------------------------ */
/* 5. GitHub repo links                                                */
/* ------------------------------------------------------------------ */

export function checkGitHubRepoLinks({ content, file, section }) {
  const failures = [];
  for (const name of extractRepoNames(content)) {
    for (const f of repoLinkFailures({ name, file, section })) failures.push(f);
  }
  return failures;
}

function repoLinkFailures({ name, file, section }) {
  const lower = name.toLowerCase();
  if (FORBIDDEN_REPO_NAMES.has(lower)) {
    return [
      fail(file, section, "repo-fork-excluded", `"${name}" is a fork and is excluded from the profile; link an upstream project instead`),
    ];
  }
  if (PRIVATE_REPOS_WITHOUT_WEBSITE.has(lower)) {
    return [
      fail(
        file,
        section,
        "repo-private-no-website",
        `"${name}" is private and has no public website — omit it entirely (github.com/belajarcarabelajar/${name} 404s for every visitor)`,
      ),
    ];
  }
  if (PRIVATE_REPOS_WITH_WEBSITE.has(lower)) {
    return [
      fail(
        file,
        section,
        "repo-private-with-website",
        `"${name}" is private but has a live website — link the website URL only, never the github.com/belajarcarabelajar/${name} URL`,
      ),
    ];
  }
  if (!KNOWN_PUBLIC_REPOS.has(lower)) {
    return [
      fail(
        file,
        section,
        "repo-not-allowlisted",
        `"${name}" is not in the known public repo allowlist — add it to KNOWN_PUBLIC_REPOS once it is verifiably public`,
      ),
    ];
  }
  return [];
}

/**
 * 7. Eligibility rules only.
 *
 * T1 scope: the denylist / allowlist / fork policy over every repo link in
 * the target. T3 EXTENDS this function with the "which repos appear" rules
 * (public, or private-with-live-website) — add cases here, not new flags.
 */
export function checkEligibilityRules({ content, file, section }) {
  const failures = [];

  for (const name of extractRepoNames(content)) {
    failures.push(...repoLinkFailures({ name, file, section }));
  }

  // A denylisted name must not be named outside a github.com link either —
  // but only when it is unambiguous. Several denylisted names are also common
  // English or product words ("cloudflare" in "Cloudflare Workers"), so a bare
  // single-word mention is NOT a violation. Only slug-shaped names
  // (containing - _ or .) or mentions inside a URL are treated as repo
  // references. This was a measured false positive, not a hypothetical one.
  const urlPaths = extractLinks(content).map((l) => decodeURIComponentSafe(l.target)).map((u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  });
  for (const name of PRIVATE_REPOS_WITHOUT_WEBSITE) {
    const slugShaped = /[-_.]/.test(name);
    // Only a URL *path* segment counts. A query param such as a shields.io
    // `logo=cloudflare` is a brand reference, not a repo link — another
    // measured false positive.
    const inUrlPath = urlPaths.some((p) =>
      new RegExp(`(^|/)${escapeRe(name)}(/|$)`, "i").test(p),
    );
    if (!slugShaped && !inUrlPath) continue;

    const re = new RegExp(`(^|[^A-Za-z0-9._-])${escapeRe(name)}([^A-Za-z0-9._-]|$)`, "i");
    const m = re.exec(content);
    if (m) {
      failures.push(
        fail(
          file,
          section,
          "repo-private-no-website",
          `"${name}" is private with no public website and must not be named or linked anywhere in the profile`,
          lineAt(content, m.index),
        ),
      );
    }
  }

  return failures;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* 6. Image / badge sanity                                             */
/* ------------------------------------------------------------------ */

export function extractImages(content) {
  const images = [];
  for (const m of content.matchAll(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g)) {
    images.push({ alt: m[1], url: m[2], index: m.index, line: lineAt(content, m.index), syntax: "markdown" });
  }
  for (const m of content.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1];
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    images.push({ alt, url: src, index: m.index, line: lineAt(content, m.index), syntax: "html" });
  }
  return images;
}

export function checkImagesAndBadges({ content, file, section }) {
  const failures = [];

  for (const img of extractImages(content)) {
    if (img.alt.trim() === "") {
      failures.push(
        fail(file, section, "image-alt-empty", `image has an empty alt text (${img.syntax} image)`, img.line),
      );
    }
    if (!/^https?:\/\//i.test(img.url.trim())) {
      failures.push(
        fail(file, section, "image-url-invalid", `image url must start with http:// or https://, got "${img.url}"`, img.line),
      );
      continue;
    }
    failures.push(...checkShieldsBadge({ url: img.url, file, section, line: img.line }));
  }

  return failures;
}

/** A shields.io badge must have a non-empty label AND message segment. */
function checkShieldsBadge({ url, file, section, line }) {
  const failures = [];
  if (!/^https?:\/\/img\.shields\.io\//i.test(url)) return failures;

  let u;
  try {
    u = new URL(url);
  } catch {
    return failures;
  }

  // Static/query form: /static/v1?label=X&message=Y
  const staticLabel = u.searchParams.get("label");
  const staticMessage = u.searchParams.get("message");
  if (staticLabel !== null || staticMessage !== null) {
    if ((staticLabel ?? "").trim() === "") {
      failures.push(fail(file, section, "badge-segment-empty", `shields.io badge has an empty label segment: ${url}`, line));
    }
    if ((staticMessage ?? "").trim() === "") {
      failures.push(fail(file, section, "badge-segment-empty", `shields.io badge has an empty message segment: ${url}`, line));
    }
    return failures;
  }

  // Path form: /badge/<label>-<message>-<color>
  const m = /^\/badge\/(.+)$/i.exec(u.pathname);
  if (!m) return failures;

  const rest = m[1];
  // Strip the style/colour tail that follows the message. A shields path
  // segment is label-message-color; color is hex or a named colour.
  const parts = rest.split("-");
  if (parts.length < 2) {
    failures.push(
      fail(file, section, "badge-segment-empty", `shields.io badge has no message segment: ${url}`, line),
    );
    return failures;
  }
  const label = parts[0];
  const message = parts[1];
  if (label.trim() === "") {
    failures.push(fail(file, section, "badge-segment-empty", `shields.io badge has an empty label segment: ${url}`, line));
  }
  if (message.trim() === "") {
    failures.push(fail(file, section, "badge-segment-empty", `shields.io badge has an empty message segment: ${url}`, line));
  }
  return failures;
}

/* ------------------------------------------------------------------ */
/* 8b. HTML block boundaries — a line starting an HTML block swallows every   */
/* following line until a blank line, so headings and lists written after a   */
/* `<p>`, `<table>` or `<details><summary>` line render as literal text.      */
/* Parent audit: this exact defect shipped What I'm Doing as one paragraph.   */
/* ------------------------------------------------------------------ */

/**
 * EXCEPTION: the template file is scaffolding prose, not shipped Markdown.
 * Single-line complete comments (`<!-- ... -->`) open AND close on the same
 * line. They never START a block, and they never END one either — an HTML
 * block runs straight through them — so they are transparent to this check
 * in both positions.
 */
export function checkHtmlBoundaries({ content, file, section }) {
  const failures = [];
  if (section === "template") return failures;
  const lines = content.split("\n");
  const completeComment = /^\s*<!--.*-->\s*$/;
  const htmlOpen = /^\s*</;
  const blank = /^\s*$/;
  for (let i = 0; i < lines.length; i++) {
    if (completeComment.test(lines[i])) continue;
    if (!htmlOpen.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && (htmlOpen.test(lines[j]) || completeComment.test(lines[j]))) j++;
    if (j >= lines.length) continue;
    if (blank.test(lines[j])) continue;
    failures.push(
      fail(
        file,
        section,
        "html-block-blank-line",
        `line ${i + 1} opens an HTML block that swallows line ${j + 1} — put a blank line between them or the Markdown renders as literal text`,
        i + 1,
      ),
    );
  }
  return failures;
}

/* ------------------------------------------------------------------ */
/* 9. Contribution graph + GitHub Stats presence                        */
/* ------------------------------------------------------------------ */

const CONTRIBUTION_GRAPH_RE = /github-readme-activity-graph\.vercel\.app|gitlyy\.vercel\.app\/api\/contribution|contrib\.rocks|github-readme-stats.*contribution|contribution-graphs?\./i;
const GITHUB_STATS_RE = /github-stats-extended\.vercel\.app|github-readme-stats\.vercel\.app|github-profile-summary-cards|github-readme-streak-stats/i;

export function checkStatsPresence({ content, file, section }) {
  const failures = [];
  if (section !== "all") return failures;

  const urls = extractImages(content).map((i) => i.url);
  const hasGraph = urls.some((u) => CONTRIBUTION_GRAPH_RE.test(u));
  const hasStats = urls.some((u) => GITHUB_STATS_RE.test(u));

  if (!hasGraph) {
    failures.push(
      fail(file, section, "missing-contribution-graph", "README.md has no contribution-graph image URL"),
    );
  }
  if (!hasStats) {
    failures.push(fail(file, section, "missing-github-stats", "README.md has no GitHub Stats image URL"));
  }
  return failures;
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/** The offline check set that applies to a target with the given section. */
export function checksForSection(section) {
  const checks = [checkForbiddenFigures, checkPlaceholders, checkLinks, checkGitHubRepoLinks, checkImagesAndBadges, checkHtmlBoundaries];
  if (section === "all") checks.push(checkSectionOrder, checkStatsPresence);
  return checks;
}

export function validateContent({ content, file, section }) {
  const failures = [];
  for (const check of checksForSection(section)) {
    failures.push(...check({ content, file, section }));
  }
  return failures;
}

export function validateFile({ file, repoRoot }) {
  const abs = isAbsolute(file) ? file : resolve(repoRoot, file);
  const display = displayPath(abs, repoRoot);
  const section = sectionForFilename(abs);
  if (!existsSync(abs)) {
    return [fail(display, section, "target-missing", `target file does not exist: ${abs}`)];
  }
  if (statSync(abs).isDirectory()) {
    return [fail(display, section, "target-missing", `target is a directory, not a file: ${abs}`)];
  }
  const content = readFileSync(abs, "utf8");
  return validateContent({ content, file: display, section });
}

function displayPath(abs, root) {
  const rel = relative(root, abs);
  if (rel && !rel.startsWith("..")) return rel.split(sep).join("/");
  return abs;
}

/* ------------------------------------------------------------------ */
/* Glob expansion (shell-style `*`, plus already-expanded literal paths) */
/* ------------------------------------------------------------------ */

export function globToRegExp(pattern) {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += escapeRe(ch).replace(/\\\\/g, "\\\\");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Resolve a --target-glob argument to a list of absolute file paths.
 * A pattern (contains `*` or `?`) is matched against the repo root; a
 * literal path is accepted as-is, because the shell may have already
 * expanded the glob before the script saw it.
 */
export function expandGlob(pattern, repoRoot) {
  const literal = isAbsolute(pattern) ? pattern : resolve(repoRoot, pattern);
  const hasMeta = /[*?]/.test(pattern);
  if (!hasMeta) {
    return existsSync(literal) && statSync(literal).isFile() ? [literal] : [];
  }

  const re = globToRegExp(pattern);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      const rel = relative(repoRoot, full).split(sep).join("/");
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && re.test(rel)) out.push(full);
    }
  };
  walk(repoRoot);
  return out.sort();
}

/* ------------------------------------------------------------------ */
/* 8. --links: liveness of every outbound URL                          */
/* ------------------------------------------------------------------ */

/** The only two allowed bot blocks, and only these. */
const LINK_ALLOWANCES = [
  { match: /tumblr\.com/i, expected: 403, why: "Tumblr returns 403 to non-browser clients; verified alive in a real browser 2026-10-04" },
  { match: /linkedin\.com/i, expected: 999, why: "LinkedIn returns 999 to non-browser clients; verified alive via search index 2026-10-04" },
];

const LINK_TIMEOUT_MS = 10_000;

function allowanceFor(url, status) {
  return LINK_ALLOWANCES.find((a) => a.match.test(url) && a.expected === status) ?? null;
}

async function headWithFallback(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_TIMEOUT_MS);
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (res.status === 405) {
      res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    }
    return res.status;
  } catch (err) {
    return err?.name === "AbortError" ? "timeout" : 0;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkLinkLiveness({ content, file, section }) {
  const failures = [];
  const notes = [];
  const urls = [...new Set(extractLinks(content).map((l) => decodeURIComponentSafe(l.target).trim()))].filter(
    (u) => /^https?:\/\//i.test(u),
  );

  for (const url of urls) {
    const status = await headWithFallback(url);
    if (typeof status === "number" && status >= 200 && status < 300) continue;

    const allowance = typeof status === "number" ? allowanceFor(url, status) : null;
    if (allowance) {
      notes.push(`ALLOWED  [${section}] ${url} → ${status} (known bot block: ${allowance.why})`);
      continue;
    }
    failures.push(
      fail(
        file,
        section,
        "dead-link",
        typeof status === "string"
          ? `outbound URL did not respond within ${LINK_TIMEOUT_MS / 1000}s: ${url}`
          : `outbound URL returned ${status}: ${url}`,
      ),
    );
  }

  return { failures, notes, urls };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const USAGE = `verify-profile.mjs — GitHub profile README validator

  --section <name>            validate that section of the default target (README.md)
  --section template --target <file>
  --target <file>             validate one file; section inferred from its filename prefix
  --target-glob <pattern|path...>   validate every matching fragment (accepts shell-expanded paths)
  --rules                     eligibility rules only (Task T3 extends these)
  --links                     HEAD every outbound URL (the only network mode)
  --all                       every offline check, offline only
  --all --links               offline checks + link liveness
  --root <dir>                repo root override (default: parent of scripts/)
  --help                      this text

Exit 0 = pass, 1 = validation failure, 2 = usage error.`;

export function parseArgs(argv) {
  const opts = {
    section: null,
    targets: [],
    globs: [],
    root: null,
    rules: false,
    links: false,
    all: false,
    help: false,
  };
  const VALUE_FLAGS = new Set(["--section", "--target", "--target-glob", "--root"]);
  const BOOL_FLAGS = new Set(["--rules", "--links", "--all", "--help", "-h"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      if (arg === "--target-glob") {
        // Variadic: consume values until the next flag.
        let n = i + 1;
        while (n < argv.length && !argv[n].startsWith("--")) {
          opts.globs.push(argv[n]);
          n++;
        }
        if (n === i + 1) return { error: "--target-glob requires a pattern or at least one path" };
        i = n - 1;
        continue;
      }
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} requires a value` };
      if (arg === "--section") opts.section = value;
      else if (arg === "--target") opts.targets.push(value);
      else if (arg === "--root") opts.root = value;
      continue;
    }
    if (BOOL_FLAGS.has(arg)) {
      if (arg === "--rules") opts.rules = true;
      else if (arg === "--links") opts.links = true;
      else if (arg === "--all") opts.all = true;
      else opts.help = true;
      continue;
    }
    return { error: `unknown flag: ${arg}` };
  }
  return opts;
}

function printFailure(f) {
  const line = f.line !== undefined ? ` (line ${f.line})` : "";
  process.stdout.write(`  FAIL ${f.file} — [${f.section}] ${f.rule}: ${f.message}${line}\n`);
}

function report(failures, label, notes = []) {
  for (const f of failures) printFailure(f);
  for (const n of notes) process.stdout.write(`  ${n}\n`);
  if (failures.length === 0) {
    process.stdout.write(`  PASS ${label}\n`);
  } else {
    process.stdout.write(`  ${failures.length} failure(s) in ${label}\n`);
  }
}

function reportDenylist() {
  process.stdout.write(
    `  eligibility: ${PRIVATE_REPOS_WITHOUT_WEBSITE.size} private-without-website repo(s) denylisted, ` +
      `${PRIVATE_REPOS_WITH_WEBSITE.size} private-with-website repo(s) (website link only), ` +
      `${KNOWN_PUBLIC_REPOS.size} public repo(s) allowlisted\n`,
  );
  process.stdout.write(`  denylist: ${[...PRIVATE_REPOS_WITHOUT_WEBSITE].sort().join(", ")}\n`);
}

/** `classification: N PUBLIC, N PRIVATE_WITH_WEBSITE, N DENIED` over every link seen. */
function reportClassification(links) {
  const counts = { PUBLIC: 0, PRIVATE_WITH_WEBSITE: 0, DENIED: 0 };
  for (const l of links) counts[l.decision] = (counts[l.decision] ?? 0) + 1;
  process.stdout.write(
    `  classification: ${counts.PUBLIC} PUBLIC, ${counts.PRIVATE_WITH_WEBSITE} PRIVATE_WITH_WEBSITE, ${counts.DENIED} DENIED\n`,
  );
  return counts;
}

/** Offline check set over one file. */
function runOffline(target, repoRoot, forcedSection) {
  const abs = isAbsolute(target) ? target : resolve(repoRoot, target);
  const section = forcedSection ?? sectionForFilename(abs);
  const display = displayPath(abs, repoRoot);
  if (!existsSync(abs)) {
    return { failures: [fail(display, section, "target-missing", `target file does not exist: ${abs}`)], section, display, abs };
  }
  const content = readFileSync(abs, "utf8");
  return { failures: validateContent({ content, file: display, section }), section, display, abs };
}

export async function main(argv, { repoRoot = defaultRepoRoot() } = {}) {
  const opts = parseArgs(argv);
  if (opts.error) {
    process.stderr.write(`verify-profile: ${opts.error}\n\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const root = opts.root ? resolve(opts.root) : repoRoot;
  const failures = [];
  const notes = [];

  /* --rules ---------------------------------------------------------- */
  if (opts.rules) {
    reportDenylist();
    const targets = opts.targets.length ? opts.targets : ["README.md"];
    const classified = [];
    for (const t of targets) {
      const abs = isAbsolute(t) ? t : resolve(root, t);
      const section = opts.section ?? sectionForFilename(abs);
      const display = displayPath(abs, root);
      if (!existsSync(abs)) {
        failures.push(fail(display, section, "target-missing", `target file does not exist: ${abs}`));
        continue;
      }
      const content = readFileSync(abs, "utf8");
      // --target is honoured here: each target is classified and asserted
      // independently, so a bad link in one file cannot hide behind another.
      classified.push(...classifyRepoLinks(content, { file: display }));
      failures.push(...checkEligibilityRules({ content, file: display, section }));
    }
    reportClassification(classified);
    report(failures, "--rules", notes);
    return failures.length ? 1 : 0;
  }

  /* --links ---------------------------------------------------------- */
  if (opts.links && !opts.all) {
    const targets = opts.targets.length ? opts.targets : ["README.md"];
    for (const t of targets) {
      const abs = isAbsolute(t) ? t : resolve(root, t);
      const section = opts.section ?? sectionForFilename(abs);
      const display = displayPath(abs, root);
      if (!existsSync(abs)) {
        failures.push(fail(display, section, "target-missing", `target file does not exist: ${abs}`));
        continue;
      }
      const content = readFileSync(abs, "utf8");
      const res = await checkLinkLiveness({ content, file: display, section });
      failures.push(...res.failures);
      notes.push(...res.notes);
    }
    report(failures, "--links", notes);
    return failures.length ? 1 : 0;
  }

  /* --all ------------------------------------------------------------ */
  if (opts.all) {
    const readme = runOffline("README.md", root, null);
    failures.push(...readme.failures);

    const template = join(root, "docs/PROFILE-README.template.md");
    if (existsSync(template)) {
      const t = runOffline(template, root, "template");
      failures.push(...t.failures);
    } else {
      failures.push(fail("docs/PROFILE-README.template.md", "template", "target-missing", "the profile template is required"));
    }

    for (const entry of SECTION_REGISTRY) {
      if (entry.prefix === null) continue;
      const frag = join(root, "docs/fragments", entry.filename);
      if (!existsSync(frag)) {
        failures.push(fail(`docs/fragments/${entry.filename}`, entry.section, "target-missing", "fragment is missing"));
        continue;
      }
      const f = runOffline(frag, root, null);
      failures.push(...f.failures);
    }

    const readmeContent = existsSync(join(root, "README.md")) ? readFileSync(join(root, "README.md"), "utf8") : "";
    failures.push(...checkEligibilityRules({ content: readmeContent, file: "README.md", section: "all" }));

    if (opts.links) {
      const res = await checkLinkLiveness({ content: readmeContent, file: "README.md", section: "all" });
      failures.push(...res.failures);
      notes.push(...res.notes);
    } else {
      notes.push("NOTE link liveness skipped; --all is offline by default. Re-run with --all --links to check URLs.");
    }

    reportDenylist();
    report(failures, opts.links ? "--all --links" : "--all", notes);
    return failures.length ? 1 : 0;
  }

  /* --target-glob ----------------------------------------------------- */
  if (opts.globs.length) {
    const seen = new Set();
    for (const g of opts.globs) {
      const matches = expandGlob(g, root);
      if (matches.length === 0) {
        failures.push(fail(g, "unknown", "glob-no-match", `no file matches ${g}`));
        continue;
      }
      for (const m of matches) {
        if (seen.has(m)) continue;
        seen.add(m);
        const r = runOffline(m, root, opts.section);
        failures.push(...r.failures);
      }
    }
    report(failures, `--target-glob (${seen.size} file(s))`, notes);
    return failures.length ? 1 : 0;
  }

  /* --target / --section (default target README.md) ------------------- */
  const targets = opts.targets.length ? opts.targets : ["README.md"];
  if (opts.section === "unknown") {
    process.stderr.write(`verify-profile: unknown section name "${opts.section}"\n`);
    return 2;
  }
  for (const t of targets) {
    const r = runOffline(t, root, opts.section);
    failures.push(...r.failures);
  }
  const label = opts.targets.length ? targets.join(", ") : `README.md --section ${opts.section ?? "all"}`;
  report(failures, label, notes);
  return failures.length ? 1 : 0;
}

export function defaultRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

/* ------------------------------------------------------------------ */

if (import.meta.main) {
  const code = await main(process.argv.slice(2), { repoRoot: defaultRepoRoot() });
  process.exit(code);
}
