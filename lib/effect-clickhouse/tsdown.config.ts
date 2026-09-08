import { defineConfig } from "tsdown"

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		expr: "./src/expr.ts",
		types: "./src/types.ts",
		sql: "./src/sql/index.ts",
		"benchmark/index": "./src/benchmark/index.ts",
		"benchmark/http": "./src/benchmark/http.ts",
		"benchmark/cli": "./src/benchmark/cli.ts",
		"benchmark/bin": "./src/benchmark/bin.ts",
	},
	format: "esm",
	dts: true,
	outDir: "dist",
	deps: {
		neverBundle: ["effect"],
	},
})
