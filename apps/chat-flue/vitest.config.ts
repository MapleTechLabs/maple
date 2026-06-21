import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: {
			// `app.ts` reads worker bindings from the `cloudflare:workers` virtual
			// module, which only exists in workerd. Stub it for node tests; the stub
			// exposes an empty env, so telemetry stays disabled (no-op) under test.
			"cloudflare:workers": fileURLToPath(
				new URL("./test/cloudflare-workers-stub.ts", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
})
