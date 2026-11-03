import { playwright } from "@vitest/browser-playwright"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "node",
					environment: "node",
					include: ["src/**/*.test.ts"],
					exclude: [
						...configDefaults.exclude,
						"**/.claude/**",
						"**/.context/**",
						"**/worktrees/**",
						"src/**/*.browser.test.ts",
					],
				},
			},
			{
				test: {
					name: "browser",
					include: ["src/**/*.browser.test.ts"],
					exclude: [
						...configDefaults.exclude,
						"**/.claude/**",
						"**/.context/**",
						"**/worktrees/**",
					],
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(),
						instances: [{ browser: "chromium" }],
					},
				},
			},
		],
	},
})
