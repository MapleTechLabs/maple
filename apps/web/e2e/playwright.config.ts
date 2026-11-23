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
		// Traces and videos stay off: a trace keeps request headers (the Clerk cookie and Bearer
		// token) and `.e2e/` is uploaded as a readable artifact. Screenshots carry no headers.
		trace: "off",
		video: "off",
		screenshot: "only-on-failure",
	},
	projects: [
		{ name: "setup", testMatch: /auth\.setup\.e2e\.ts$/ },
		{
			name: "web",
			testIgnore: /auth\.setup\.e2e\.ts$/,
			dependencies: ["setup"],
			use: { storageState: reviewerState },
		},
	],
})
