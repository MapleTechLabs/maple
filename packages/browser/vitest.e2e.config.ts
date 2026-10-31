import { defineConfig } from "vitest/config"

// The built SDK in a real Chromium against a fake ingest. Run with
// `bun run test:e2e`, which builds `dist/` first.
export default defineConfig({
	test: {
		name: "e2e",
		environment: "node",
		include: ["e2e/**/*.e2e.test.ts"],
		globalSetup: ["e2e/global-setup.ts"],
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
})
