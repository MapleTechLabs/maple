import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			// The `cloudflare:workers` virtual module only exists inside a Worker
			// isolate; stub it so worker-dependent services can be imported in node.
			"cloudflare:workers": fileURLToPath(
				new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
})
