import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "github-stats-card",
		compatibilityDate: "2026-09-25",
		entrypoint,
		domains: ["stats.belajarcarabelajar.com"],
		env: {
			GITHUB_LOGIN: bindings.text("belajarcarabelajar"),
			GITHUB_TOKEN: bindings.secret(),
			CARD_KV: bindings.kv(),
		},
	},
});
