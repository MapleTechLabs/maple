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
		// Generous timeouts: the DB-backed suites boot a fresh PGlite (WASM) per
		// test and some retry tests run real exponential backoff. Under CI's
		// parallel `turbo test`, CPU starvation stretches these past the 5s
		// default — without headroom a starved-but-correct test gets killed, and
		// the abandoned fiber then queries the torn-down PGlite ("PGlite is closed").
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
