import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		server: "./src/server.ts",
		nextjs: "./src/nextjs/index.ts",
		"nextjs-server": "./src/nextjs/server.ts",
	},
	format: "esm",
	// Types are emitted by tsgo in one pass rooted at the tsconfig's directory,
	// and it skips files reached through node_modules. The bundled types come
	// from `@maple/browser-session`, so this tsconfig sits in packages/ and lists
	// that package's sources as roots. Same as packages/effect-sdk.
	dts: { tsconfig: "../tsconfig.browser.dts.json" },
	outDir: "dist",
	// Rolldown can't promise to keep a module's "use client" through bundling in
	// general, but it keeps an entry module's: `dist/nextjs.mjs` starts with it.
	suppressWarnings: /module level directive "use client" in "src\/nextjs\/index\.ts"/,
})
