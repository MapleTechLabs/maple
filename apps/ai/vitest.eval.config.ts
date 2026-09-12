import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Evals are separate from the unit suite (vitest.config.ts → src/**/*.test.ts).
// They drive a real LLM via OpenRouter, so they only run via `bun run eval`,
// never as part of `bun run test`. Files match `*.eval.ts`.
export default defineConfig({
	resolve: {
		alias: {
			// Longest prefix first, and `@` is apps/api's — see vitest.config.ts.
			"@ai": fileURLToPath(new URL("./src", import.meta.url)),
			"@": fileURLToPath(new URL("../api/src", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.eval.ts"],
		// LLM round-trips are slow; give each eval generous headroom.
		testTimeout: 60_000,
		hookTimeout: 60_000,
		// One model at a time keeps OpenRouter rate-limits + logs sane.
		fileParallelism: false,
	},
})
