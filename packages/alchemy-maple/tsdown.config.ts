import { defineConfig } from "tsdown"
import libchdb from "../local-server/libchdb.json" with { type: "json" }

// The chDB release the sidecar pairs with: the manifest scripts/build-local-binary.sh
// also reads. The runtime refuses to start against any other libchdb.
const libchdbVersion = process.env.LIBCHDB_VERSION ?? libchdb.version

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		telemetry: "./src/Telemetry.ts",
		local: "./src/Local.ts",
		"local-sidecar": "./src/LocalSidecar.ts",
	},
	format: "esm",
	dts: { tsconfig: "../../tsconfig.alchemy-maple.json" },
	outDir: "dist",
	// The sidecar bundles @maple/local-server (private, never published); its
	// schema DDL is imported as text. Bun built-ins and every @effect/* package
	// stay external: they must be the same versions as the user's `effect`.
	loader: { ".sql": "text" },
	define: { __CHDB_VERSION__: JSON.stringify(libchdbVersion) },
	deps: {
		neverBundle: ["effect", /^@effect\//, "alchemy", "@maple-dev/effect-sdk", /^bun:/],
		alwaysBundle: [/^@maple\//, /^@maple-dev\/effect-orm/],
		onlyImport: ["effect", /^@effect\//, "alchemy", "@maple-dev/effect-sdk", /^node:/, /^bun:/],
	},
})
