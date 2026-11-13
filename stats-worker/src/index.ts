// Worker entry: serves /card.svg from the edge cache for 15 minutes, refreshes
// from GitHub on a miss, and falls back to the last good card (kept 7 days)
// when GitHub fails. Runs only on requests: no cron, alarm, queue, or retry.
// Kill switch: remove the custom domain or delete the Worker.
import { env } from "cloudflare:workers";
import { ERROR_SECONDS, FRESH_SECONDS, handle } from "./stats.ts";

const STALE_SECONDS = 7 * 24 * 3600;

export default {
  async fetch(req, _env, ctx) {
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== "/card.svg") return new Response("Not found", { status: 404 });

    const cache = caches.default;
    const freshKey = new Request(`${url.origin}/card.svg`);
    const staleKey = new Request(`${url.origin}/card.svg?stale`);

    // A cache hit comes back with the zone's Browser Cache TTL (4 hours on this
    // zone) in cache-control, so the header is set again on every hit.
    const hit = await cache.match(freshKey);
    if (hit) {
      const out = new Response(hit.body, hit);
      out.headers.set("cache-control", `public, max-age=${FRESH_SECONDS}`);
      return out;
    }

    const res = await handle(freshKey, { token: env.GITHUB_TOKEN, login: env.GITHUB_LOGIN });
    if (res.headers.get("x-stats") === "unavailable") {
      const stale = await cache.match(staleKey);
      if (stale) {
        const out = new Response(stale.body, stale);
        out.headers.set("cache-control", `public, max-age=${ERROR_SECONDS}`);
        return out;
      }
      return res;
    }

    const stale = res.clone();
    const staleRes = new Response(stale.body, stale);
    staleRes.headers.set("cache-control", `public, max-age=${STALE_SECONDS}`);
    ctx.waitUntil(Promise.all([cache.put(freshKey, res.clone()), cache.put(staleKey, staleRes)]));
    return res;
  },
} satisfies ExportedHandler;
