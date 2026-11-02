import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/.claude/**", "**/.context/**", "**/worktrees/**"],
		testTimeout: 60_000,
	},
})
