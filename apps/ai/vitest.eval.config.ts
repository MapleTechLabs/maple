import { defineConfig } from "vitest/config"
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.eval.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		fileParallelism: false,
	},
})
