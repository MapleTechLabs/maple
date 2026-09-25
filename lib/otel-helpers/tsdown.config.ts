import { defineConfig } from "tsdown"

// Dual format: customer repos the maple-onboard skill instruments are often CommonJS.
export default defineConfig({
	entry: { index: "./src/index.ts" },
	format: ["esm", "cjs"],
	dts: true,
	outDir: "dist",
})
