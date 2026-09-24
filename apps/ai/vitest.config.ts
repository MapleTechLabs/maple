import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// Forked processes, for the memory reason apps/api's config records.
		pool: "forks",
		// Backend and worker tests share the same migrated PGlite snapshot.
		globalSetup: ["../../packages/backend/test/global-setup.ts"],
		// Same headroom as apps/api, and for the same reasons: PGlite-per-test, real
		// exponential backoff in the retry suites, and CPU starvation under a
		// parallel `turbo test` stretching both past the 5s default.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
