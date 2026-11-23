import { playwright } from "@vitest/browser-playwright"
import { configDefaults, defineConfig } from "vitest/config"

const exclude = [...configDefaults.exclude, "**/.claude/**", "**/.context/**", "**/worktrees/**"]

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		server: { deps: { inline: ["foldkit", "@foldkit/ui"] } },
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					// Scene and Story run on VNodes: no DOM environment is needed.
					environment: "node",
					include: ["src/**/*.test.ts"],
					exclude: [...exclude, "src/**/*.browser.test.ts"],
					setupFiles: ["./vitest-setup.ts"],
				},
			},
			{
				extends: true,
				// Code that reads layout or dispatches real DOM events runs in Chromium.
				test: {
					name: "browser",
					include: ["src/**/*.browser.test.ts"],
					exclude,
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
