import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: {
		// Scene and Story run on VNodes: no DOM environment is needed.
		environment: "node",
		include: ["src/**/*.test.ts"],
		setupFiles: ["./src/vitest-setup.ts"],
		server: { deps: { inline: ["foldkit", "@foldkit/ui"] } },
	},
})
