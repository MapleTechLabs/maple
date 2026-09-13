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
		// Threads over forked processes, for the reason apps/api's config records:
		// process startup and the per-worker module registry dominate otherwise.
		pool: "threads",
		// Backend and worker tests share the same migrated PGlite snapshot.
		globalSetup: ["../../packages/backend/test/global-setup.ts"],
		// Same headroom as apps/api, and for the same reasons: PGlite-per-test, real
		// exponential backoff in the retry suites, and CPU starvation under a
		// parallel `turbo test` stretching both past the 5s default.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
