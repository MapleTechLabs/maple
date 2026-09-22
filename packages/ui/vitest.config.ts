import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		// Pure calculations do not need a browser. DOM suites opt in with the
		// standard @vitest-environment jsdom directive next to their imports.
		environment: "node",
		include: ["src/**/*.test.{ts,tsx}"],
	},
})
