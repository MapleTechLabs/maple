import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		index: "./src/index.ts",
	},
	format: "esm",
	// Types are emitted by tsgo in one pass rooted at the tsconfig's directory,
	// and it skips files reached through node_modules. The bundled types come
	// from `@maple/browser-session`, so this tsconfig sits in packages/ and lists
	// that package's sources as roots. Same as packages/effect-sdk.
	dts: { tsconfig: "../tsconfig.browser.dts.json" },
	outDir: "dist",
})
