import { playwright } from "@vitest/browser-playwright"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	resolve: { dedupe: ["react", "react-dom"] },
	test: {
		projects: [
			{
				test: {
					name: "node",
					benchmark: { exclude: ["src/**/*.browser.bench.ts"] },
					environment: "node",
					include: ["src/**/*.test.{ts,tsx}"],
					exclude: [
						...configDefaults.exclude,
						"**/.claude/**",
						"**/.context/**",
						"**/worktrees/**",
						"src/**/*.browser.test.{ts,tsx}",
					],
				},
			},
			{
				test: {
					name: "browser",
					benchmark: { include: ["src/**/*.browser.bench.ts"] },
					include: ["src/**/*.browser.test.{ts,tsx}"],
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
