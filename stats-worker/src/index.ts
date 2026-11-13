// Worker entry: serves /card.svg straight from KV and refreshes the stored
// card in the background when it is older than 15 minutes (see serveCard).
// Runs only on requests: no cron, alarm, queue, or retry; at most one refresh
// attempt per 15 minutes. Kill switch: remove the custom domain or delete the Worker.
import { env } from "cloudflare:workers";
import { buildCard, serveCard } from "./stats.ts";

export default {
  async fetch(req, _env, ctx) {
    if (req.method !== "GET") return new Response("Not found", { status: 404 });
    return serveCard(req, {
      kv: env.CARD_KV,
      now: Date.now(),
      build: () => buildCard({ token: env.GITHUB_TOKEN, login: env.GITHUB_LOGIN }),
      waitUntil: (p) => ctx.waitUntil(p),
    });
  },
} satisfies ExportedHandler;
