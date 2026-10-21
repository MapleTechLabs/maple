import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/.claude/**", "**/.context/**", "**/worktrees/**"],
	},
})
