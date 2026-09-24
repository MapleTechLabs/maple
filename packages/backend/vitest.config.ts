import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// Forked processes, not worker threads. Threads measured ~3s faster on the
		// full suite, but on Linux CI the one process hosting every thread grew past
		// the runner's 16 GB over ~140 files of PGlite instances and was SIGKILLed
		// (exit 137, main on 2026-09-21); a fork hands its memory back at exit.
		// `isolate` stays on: turning it off measured slower overall.
		pool: "forks",
		// Builds the post-migration PGlite data directory that createTestDb boots
		// from. See test/pglite-snapshot.ts — without it every test pays a full
		// initdb inside WASM.
		globalSetup: ["./test/global-setup.ts"],
		// Generous timeouts: the DB-backed suites boot a fresh PGlite (WASM) per
		// test and some retry tests run real exponential backoff. Under CI's
		// parallel `turbo test`, CPU starvation stretches these past the 5s
		// default — without headroom a starved-but-correct test gets killed, and
		// the abandoned fiber then queries the torn-down PGlite ("PGlite is closed").
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
