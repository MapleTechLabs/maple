import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: {
			// Longest prefix first: "@ai" must not be swallowed by "@". The mapping
			// mirrors tsconfig — `@` is apps/api's source, because this worker's
			// graph pulls api modules in and they spell their own imports that way.
			"@ai": fileURLToPath(new URL("./src", import.meta.url)),
			"@": fileURLToPath(new URL("../api/src", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// Threads over forked processes, for the reason apps/api's config records:
		// process startup and the per-worker module registry dominate otherwise.
		pool: "threads",
		// The moved suites boot PGlite through api's `createTestDb`, so they need
		// api's snapshot. Pointing at api's setup rather than copying it keeps one
		// post-migration data directory instead of two racing builders.
		globalSetup: ["../api/test/global-setup.ts"],
		// Same headroom as apps/api, and for the same reasons: PGlite-per-test, real
		// exponential backoff in the retry suites, and CPU starvation under a
		// parallel `turbo test` stretching both past the 5s default.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
