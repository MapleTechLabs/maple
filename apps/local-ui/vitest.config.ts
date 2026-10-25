import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		// Scene runs on VNodes: no DOM environment is needed.
		environment: "node",
		include: ["src/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "**/.claude/**", "**/.context/**", "**/worktrees/**"],
		setupFiles: ["./src/vitest-setup.ts"],
		server: { deps: { inline: ["foldkit", "@foldkit/ui"] } },
	},
})
