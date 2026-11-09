import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		server: { deps: { inline: ["@effect/vitest"] } },
		environment: "node",
		include: ["src/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/.claude/**", "**/.context/**", "**/worktrees/**"],
	},
})
