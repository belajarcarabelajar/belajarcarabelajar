// GitHub Stats card: fetch totals from the GitHub GraphQL API and render a
// tokyonight SVG. Pure functions plus one request handler; the Worker entry
// (index.ts) adds the Cloudflare cache around `handle`.

export type Profile = {
  id: string;
  name: string;
  stars: number;
  prs: number;
  issues: number;
  contributedTo: number;
};

export type Stats = {
  name: string;
  stars: number;
  commits: number;
  prs: number;
  issues: number;
  contributedTo: number;
};

// Counts include private repositories the token can read (totals only).
// Stars count public, non-fork repositories owned by the user.
export const PROFILE_QUERY = `query($login: String!) {
  user(login: $login) {
    id
    name
    login
    pullRequests(first: 1) { totalCount }
    issues { totalCount }
    repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false) { nodes { stargazerCount } }
  }
}`;

// Commits = default-branch commits authored by the user in the last year,
// summed over their own non-fork repositories. contributionsCollection is not
// used: a fine-grained token never sees private commit contributions there
// (measured 2026-11-13: 4,909 vs 16,866 summed per repository).
export const COMMITS_QUERY = `query($login: String!, $id: ID!, $since: GitTimestamp!, $cursor: String) {
  user(login: $login) {
    repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
      pageInfo { hasNextPage endCursor }
      nodes { defaultBranchRef { target { ... on Commit { history(since: $since, author: { id: $id }) { totalCount } } } } }
    }
  }
}`;

export const MAX_COMMIT_PAGES = 5;
export const FRESH_SECONDS = 900;
export const ERROR_SECONDS = 60;

function userOf(json: any): any {
  if (json?.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join("; "));
  const u = json?.data?.user;
  if (!u) throw new Error("GitHub response has no user");
  return u;
}

export function parseStats(json: any): Profile {
  const u = userOf(json);
  return {
    id: u.id,
    name: u.name || u.login,
    stars: u.repositories.nodes.reduce((sum: number, r: any) => sum + r.stargazerCount, 0),
    prs: u.pullRequests.totalCount,
    issues: u.issues.totalCount,
    contributedTo: u.repositoriesContributedTo.totalCount,
  };
}

export function parseCommitPage(json: any): { commits: number; next: string | null } {
  const repos = userOf(json).repositories;
  const commits = repos.nodes.reduce(
    (sum: number, r: any) => sum + (r.defaultBranchRef?.target?.history?.totalCount ?? 0),
    0,
  );
  return { commits, next: repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n: number) => n.toLocaleString("en-US");

// tokyonight palette, same as the github-stats-extended theme.
const C = { bg: "#1a1b27", title: "#70a5fd", text: "#38bdae", icon: "#bf91f3" };

function frame(title: string, body: string, height: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="467" height="${height}" viewBox="0 0 467 ${height}" role="img" aria-labelledby="t">` +
    `<title id="t">${esc(title)}</title>` +
    `<style>.h{font:600 18px 'Segoe UI',Ubuntu,sans-serif;fill:${C.title}}.l{font:600 14px 'Segoe UI',Ubuntu,sans-serif;fill:${C.text}}.v{font:700 14px 'Segoe UI',Ubuntu,sans-serif;fill:${C.text}}.d{fill:${C.icon}}</style>` +
    `<rect width="467" height="${height}" rx="4.5" fill="${C.bg}"/>` +
    `<text x="25" y="35" class="h">${esc(title)}</text>` +
    body +
    `</svg>`
  );
}

export function renderCard(s: Stats): string {
  const rows: Array<[string, number]> = [
    ["Total Stars Earned", s.stars],
    ["Total Commits (last year)", s.commits],
    ["Total PRs", s.prs],
    ["Total Issues", s.issues],
    ["Contributed to (last year)", s.contributedTo],
  ];
  const body = rows
    .map(([label, n], i) => {
      const y = 70 + i * 25;
      return `<circle cx="32" cy="${y - 5}" r="5" class="d"/><text x="48" y="${y}" class="l">${label}:</text><text x="300" y="${y}" class="v">${fmt(n)}</text>`;
    })
    .join("");
  return frame(`${s.name}'s GitHub Stats`, body, 195);
}

export function renderUnavailable(): string {
  return frame("GitHub Stats", `<text x="25" y="70" class="l">Stats temporarily unavailable</text>`, 100);
}

type Options = {
  token: string;
  login: string;
  fetchFn?: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  now?: number;
};

const svgResponse = (body: string, maxAge: number, extra: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": `public, max-age=${maxAge}`, ...extra },
  });

export async function buildCard(o: Options): Promise<string> {
  const fetchFn = o.fetchFn ?? fetch;
  const gql = async (query: string, variables: Record<string, unknown>) => {
    const res = await fetchFn("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json", "user-agent": "stats-worker" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return res.json();
  };
  const { id, ...profile } = parseStats(await gql(PROFILE_QUERY, { login: o.login }));
  const since = new Date((o.now ?? Date.now()) - 365 * 24 * 3600 * 1000).toISOString();
  let commits = 0;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_COMMIT_PAGES; page++) {
    const r = parseCommitPage(await gql(COMMITS_QUERY, { login: o.login, id, since, cursor }));
    commits += r.commits;
    if (!r.next) break;
    cursor = r.next;
  }
  return renderCard({ ...profile, commits });
}

// Stored in KV under "card". `tried` marks a failed refresh, so GitHub is not
// asked again for FRESH_SECONDS after an error.
type Entry = { svg: string; at: number; tried?: number };

type ServeDeps = {
  kv: { get(key: string, type: "json"): Promise<Entry | null>; put(key: string, value: string): Promise<void> };
  now: number;
  build: () => Promise<string>;
  waitUntil: (p: Promise<unknown>) => void;
};

// Always answers from KV without waiting on GitHub (GitHub's image proxy times
// out on slow origins; a cold build took ~4.7 s). A card older than
// FRESH_SECONDS is rebuilt after the response, at most once per FRESH_SECONDS.
export async function serveCard(req: Request, d: ServeDeps): Promise<Response> {
  if (new URL(req.url).pathname !== "/card.svg") return new Response("Not found", { status: 404 });
  const entry = await d.kv.get("card", "json");

  if (!entry) {
    try {
      const svg = await d.build();
      d.waitUntil(d.kv.put("card", JSON.stringify({ svg, at: d.now })));
      return svgResponse(svg, FRESH_SECONDS);
    } catch (err) {
      console.error("stats build failed:", err instanceof Error ? err.message : err);
      return svgResponse(renderUnavailable(), ERROR_SECONDS);
    }
  }

  const lastAttempt = Math.max(entry.at, entry.tried ?? 0);
  if (d.now - lastAttempt > FRESH_SECONDS * 1000) {
    d.waitUntil(
      d
        .build()
        .then((svg) => d.kv.put("card", JSON.stringify({ svg, at: d.now })))
        .catch((err) => {
          console.error("stats refresh failed:", err instanceof Error ? err.message : err);
          return d.kv.put("card", JSON.stringify({ ...entry, tried: d.now }));
        }),
    );
  }
  return svgResponse(entry.svg, FRESH_SECONDS);
}
