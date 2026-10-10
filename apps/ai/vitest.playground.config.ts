import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// The tool playground (`scripts/tool-playground.sh`): one tool call per run against a fixture
// world, for agents testing the tools by using them. Vitest only because the eval runtime's
// PGlite snapshot comes from the global setup.
export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/evals/playground/*.playground.ts"],
		globalSetup: ["../../packages/backend/test/global-setup.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
