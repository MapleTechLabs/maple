import { foldkit } from "@foldkit/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

// The `maple` binary serves the static build and owns `/local/*` and `/v1/*`; in dev Vite
// proxies both to a running binary. `dist/` is deployed to local.maple.dev and embedded in
// the binary (scripts/gen-ui-embed.ts, apps/ingest/ui-dist).
const LOCAL_BINARY_URL = process.env.MAPLE_LOCAL_URL ?? "http://127.0.0.1:4318"

export default defineConfig(({ command }) => ({
	resolve: { tsconfigPaths: true },
	plugins: [
		tailwindcss(),
		// The DevTools MCP relay only exists on the dev server.
		foldkit(command === "serve" ? {} : { devToolsMcpPort: false }),
	],
	build: { outDir: "dist", emptyOutDir: true },
	server: {
		proxy: {
			"/local": { target: LOCAL_BINARY_URL, changeOrigin: true },
			"/v1": { target: LOCAL_BINARY_URL, changeOrigin: true },
		},
	},
}))
