import { describe, expect, test } from "bun:test";
import { parseStats, parseCommitPage, renderCard, renderUnavailable, buildCard, serveCard } from "../src/stats.ts";

// Shapes of real GitHub GraphQL responses (values from the account on
// 2026-11-13), so the expected numbers are independent literals.
const profile = {
  data: {
    user: {
      id: "U_abc",
      name: "Iwan Kurniawan",
      login: "belajarcarabelajar",
      pullRequests: { totalCount: 1963 },
      issues: { totalCount: 452 },
      repositoriesContributedTo: { totalCount: 5 },
      repositories: { nodes: [{ stargazerCount: 1 }, { stargazerCount: 0 }, { stargazerCount: 3 }] },
    },
  },
};

const commitPage = (counts: Array<number | null>, next: string | null) => ({
  data: {
    user: {
      repositories: {
        pageInfo: { hasNextPage: next !== null, endCursor: next },
        nodes: counts.map((c) =>
          c === null ? { defaultBranchRef: null } : { defaultBranchRef: { target: { history: { totalCount: c } } } },
        ),
      },
    },
  },
});

describe("parseStats", () => {
  test("maps the profile response to the card numbers and the user id", () => {
    expect(parseStats(profile)).toEqual({
      id: "U_abc",
      name: "Iwan Kurniawan",
      stars: 4,
      prs: 1963,
      issues: 452,
      contributedTo: 5,
    });
  });

  test("falls back to the login when the profile has no name", () => {
    const noName = structuredClone(profile);
    noName.data.user.name = null as unknown as string;
    expect(parseStats(noName).name).toBe("belajarcarabelajar");
  });

  test("throws on a GraphQL error payload", () => {
    expect(() => parseStats({ errors: [{ message: "Bad credentials" }] })).toThrow("Bad credentials");
  });
});

describe("parseCommitPage", () => {
  test("sums default-branch commits and treats empty repos as zero", () => {
    expect(parseCommitPage(commitPage([12985, 3881, null], "c1"))).toEqual({ commits: 16866, next: "c1" });
  });

  test("reports no next cursor on the last page", () => {
    expect(parseCommitPage(commitPage([7], null))).toEqual({ commits: 7, next: null });
  });
});

describe("renderCard", () => {
  const svg = renderCard({ ...parseStats(profile), commits: 16866 });

  test("is an svg document with an accessible title", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<title");
    expect(svg).toContain("Iwan Kurniawan's GitHub Stats");
  });

  test("shows every number formatted with thousands separators", () => {
    for (const n of ["16,866", "1,963", "452", ">4<", ">5<"]) expect(svg).toContain(n);
  });

  test("escapes markup in the name", () => {
    const evil = renderCard({ ...parseStats(profile), commits: 1, name: "<b>&x" });
    expect(evil).toContain("&lt;b&gt;&amp;x");
    expect(evil).not.toContain("<b>");
  });
});

describe("buildCard", () => {
  // Answers the profile query, then two commit pages chained by cursor.
  const pagedFetch = async (_input: RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (!body.query.includes("history")) return Response.json(profile);
    if (!body.variables.cursor) return Response.json(commitPage([10000, 2985], "p2"));
    return Response.json(commitPage([3881], null));
  };

  test("adds up commits across every page of repositories", async () => {
    const svg = await buildCard({ token: "t", login: "belajarcarabelajar", fetchFn: pagedFetch });
    expect(svg).toContain(">16,866<");
    expect(svg).toContain(">1,963<");
  });

  test("passes the user id and a one-year window to the commit query", async () => {
    const bodies: any[] = [];
    const spy = async (input: RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return pagedFetch(input, init);
    };
    await buildCard({ token: "t", login: "belajarcarabelajar", fetchFn: spy, now: Date.parse("2026-11-13T00:00:00Z") });
    const commitQuery = bodies.find((b) => b.query.includes("history"));
    expect(commitQuery.variables.id).toBe("U_abc");
    expect(commitQuery.variables.since).toBe("2025-11-13T00:00:00.000Z");
  });

  test("sends the token as a bearer header to the GitHub GraphQL endpoint", async () => {
    let seen: Request | undefined;
    const spy = async (input: RequestInfo, init?: RequestInit) => {
      seen = new Request(input, init);
      return pagedFetch(input, init);
    };
    await buildCard({ token: "abc", login: "belajarcarabelajar", fetchFn: spy });
    expect(seen?.url).toBe("https://api.github.com/graphql");
    expect(seen?.headers.get("authorization")).toBe("Bearer abc");
  });

  test("stops after five commit pages even if GitHub keeps returning a cursor", async () => {
    let calls = 0;
    const endless = async (_i: RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (!body.query.includes("history")) return Response.json(profile);
      calls++;
      return Response.json(commitPage([1], `p${calls + 1}`));
    };
    const svg = await buildCard({ token: "t", login: "x", fetchFn: endless });
    expect(calls).toBe(5);
    expect(svg).toContain(">5<");
  });

  test("throws when GitHub answers with an error status", async () => {
    const bad = async () => new Response("nope", { status: 502 });
    await expect(buildCard({ token: "t", login: "x", fetchFn: bad })).rejects.toThrow("GitHub API 502");
  });
});

describe("serveCard", () => {
  const MIN = 60_000;
  const T0 = Date.parse("2026-11-13T00:00:00Z");

  // In-memory stand-in for a KV namespace (system boundary).
  function fakeKv(initial?: unknown) {
    const store = new Map<string, string>();
    if (initial) store.set("card", JSON.stringify(initial));
    const puts: unknown[] = [];
    return {
      puts,
      kv: {
        get: async (k: string, _t: "json") => (store.has(k) ? JSON.parse(store.get(k)!) : null),
        put: async (k: string, v: string) => {
          puts.push(JSON.parse(v));
          store.set(k, v);
        },
      },
    };
  }

  function run(entry: unknown, now: number, build: () => Promise<string>, path = "/card.svg") {
    const { kv, puts } = fakeKv(entry);
    const background: Promise<unknown>[] = [];
    let builds = 0;
    const counted = () => {
      builds++;
      return build();
    };
    const res = serveCard(new Request(`https://stats.example${path}`), {
      kv,
      now,
      build: counted,
      waitUntil: (p) => background.push(p),
    });
    return { res, puts, background, builds: () => builds };
  }

  test("serves a fresh stored card without calling GitHub", async () => {
    const r = run({ svg: "<svg>old</svg>", at: T0 }, T0 + 5 * MIN, async () => "<svg>new</svg>");
    const res = await r.res;
    expect(await res.text()).toBe("<svg>old</svg>");
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(r.builds()).toBe(0);
  });

  test("serves a stale card immediately and refreshes it in the background", async () => {
    const r = run({ svg: "<svg>old</svg>", at: T0 }, T0 + 20 * MIN, async () => "<svg>new</svg>");
    expect(await (await r.res).text()).toBe("<svg>old</svg>");
    await Promise.all(r.background);
    expect(r.builds()).toBe(1);
    expect(r.puts).toEqual([{ svg: "<svg>new</svg>", at: T0 + 20 * MIN }]);
  });

  test("a failed refresh keeps the old card and waits 15 minutes before trying again", async () => {
    const r = run({ svg: "<svg>old</svg>", at: T0 }, T0 + 20 * MIN, async () => {
      throw new Error("GitHub API 502");
    });
    expect(await (await r.res).text()).toBe("<svg>old</svg>");
    await Promise.all(r.background);
    expect(r.puts).toEqual([{ svg: "<svg>old</svg>", at: T0, tried: T0 + 20 * MIN }]);

    const again = run({ svg: "<svg>old</svg>", at: T0, tried: T0 + 20 * MIN }, T0 + 30 * MIN, async () => "<svg>new</svg>");
    await again.res;
    await Promise.all(again.background);
    expect(again.builds()).toBe(0);
  });

  test("builds and stores the card on the very first request", async () => {
    const r = run(undefined, T0, async () => "<svg>first</svg>");
    expect(await (await r.res).text()).toBe("<svg>first</svg>");
    await Promise.all(r.background);
    expect(r.puts).toEqual([{ svg: "<svg>first</svg>", at: T0 }]);
  });

  test("answers 'unavailable' with a short cache when the first build fails", async () => {
    const r = run(undefined, T0, async () => {
      throw new Error("boom");
    });
    const res = await r.res;
    expect(await res.text()).toBe(renderUnavailable());
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("returns 404 for any other path", async () => {
    const r = run(undefined, T0, async () => "<svg/>", "/other");
    expect((await r.res).status).toBe(404);
    expect(r.builds()).toBe(0);
  });
});
