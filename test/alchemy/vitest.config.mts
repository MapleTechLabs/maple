// Live-infra lane: stacks deployed by alchemy's test harness (local workerd under `dev: true`).
// Not one of the root `projects`, so `bun run test` never runs it; see `bun run test:alchemy`.
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		// api's app-local alias, as in tsconfig.alchemy.json.
		alias: { "@": fileURLToPath(new URL("../../apps/api/src", import.meta.url)) },
	},
	test: {
		root: fileURLToPath(new URL(".", import.meta.url)),
		include: ["**/*.test.ts"],
		environment: "node",
		pool: "forks",
		fileParallelism: false,
		testTimeout: 60_000,
	},
})
