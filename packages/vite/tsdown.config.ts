import { defineConfig } from "tsdown"

export default defineConfig({
	entry: { index: "./src/index.ts" },
	format: "esm",
	dts: { tsconfig: "../tsconfig.vite.dts.json" },
	outDir: "dist",
	// @maple/sourcemaps is private, so it is bundled. effect stays a dependency: one copy for the
	// plugin and its platform layer. vite is the user's own.
	deps: {
		neverBundle: ["effect", /^@effect\//, "vite"],
		alwaysBundle: [/^@maple\//],
		onlyImport: ["effect", /^@effect\//, "vite", /^node:/],
	},
})
