import { defineConfig } from "playwright/test"

import { reviewerState } from "./tests/support"

// Runs against a deployed stack: a PR preview in CI, any signed-in-able URL locally.
export default defineConfig({
	testDir: "tests",
	testMatch: /\.e2e\.ts$/,
	outputDir: ".e2e/results",
	timeout: 180_000,
	expect: { timeout: 15_000 },
	forbidOnly: process.env.CI !== undefined,
	reporter:
		process.env.CI === undefined ? [["list"]] : [["list"], ["junit", { outputFile: ".e2e/junit.xml" }]],
	use: {
		baseURL: process.env.MAPLE_E2E_APP_URL ?? "http://localhost:3471",
		browserName: "chromium",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		// No trace or screenshot of the sign-in: it would carry the fresh session.
		{
			name: "setup",
			testMatch: /auth\.setup\.e2e\.ts$/,
			use: { trace: "off", screenshot: "off" },
		},
		{
			name: "web",
			testIgnore: /auth\.setup\.e2e\.ts$/,
			dependencies: ["setup"],
			use: { storageState: reviewerState },
		},
	],
})
