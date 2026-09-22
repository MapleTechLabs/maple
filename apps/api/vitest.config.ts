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
		include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
		// Forked processes, as in packages/backend. Threads measured ~3s faster here,
		// but on Linux the one process hosting every PGlite thread keeps the memory
		// freed at each file's end; a fork hands it back at exit. `isolate` stays on.
		pool: "forks",
		// Builds the post-migration PGlite data directory that createTestDb boots
		// from. See test/pglite-snapshot.ts — without it every test pays a full
		// initdb inside WASM.
		globalSetup: ["../../packages/backend/test/global-setup.ts"],
		// Generous timeouts: the DB-backed suites boot a fresh PGlite (WASM) per
		// test and some retry tests run real exponential backoff. Under CI's
		// parallel `turbo test`, CPU starvation stretches these past the 5s
		// default — without headroom a starved-but-correct test gets killed, and
		// the abandoned fiber then queries the torn-down PGlite ("PGlite is closed").
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
