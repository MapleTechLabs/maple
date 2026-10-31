import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		telemetry: "./src/Telemetry.ts",
	},
	format: "esm",
	dts: { tsconfig: "../../tsconfig.alchemy-maple.json" },
	outDir: "dist",
	deps: {
		neverBundle: ["effect", "alchemy", "@maple-dev/effect-sdk"],
		alwaysBundle: [/^@maple\//, /^@maple-dev\/effect-orm/],
		onlyImport: ["effect", "alchemy", "@maple-dev/effect-sdk", /^node:/],
	},
})
