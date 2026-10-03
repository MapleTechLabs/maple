import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		"index.server": "./src/index.server.ts",
		"index.client": "./src/index.client.ts",
		"server/index": "./src/server/index.ts",
		"client/index": "./src/client/index.ts",
		"cloudflare/index": "./src/cloudflare/index.ts",
	},
	format: "esm",
	// Types are emitted by tsgo in one pass rooted at the tsconfig's directory,
	// and it skips files reached through node_modules. The bundled types come
	// from `@maple/browser-session`, so this tsconfig sits in packages/ and lists
	// that package's sources as roots. Same as packages/browser.
	dts: { tsconfig: "../tsconfig.effect-sdk.dts.json" },
	outDir: "dist",
	deps: {
		neverBundle: ["effect"],
	},
})
