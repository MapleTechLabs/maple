import { defineConfig } from "tsdown"

// Effect rc.118 promoted `effect/unstable/{http,observability}` to
// `effect/{http,observability}` and dropped the old paths. The monorepo still
// builds against an earlier rc, so the source keeps the unstable paths and the
// published tarball (`prepack`) is built with them rewritten.
const stableEffectPaths = process.env.MAPLE_EFFECT_STABLE_PATHS === "1"

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
	plugins: stableEffectPaths
		? [
				{
					name: "maple:effect-stable-paths",
					renderChunk(code) {
						return code.replaceAll(/(["'])effect\/unstable\//g, "$1effect/")
					},
				},
			]
		: [],
})
