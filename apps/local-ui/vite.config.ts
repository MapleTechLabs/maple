import { defineConfig } from "vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import tsconfigPaths from "vite-tsconfig-paths"

// The local Maple binary (`maple start`) serves this SPA from its own origin and
// owns the `/local/query` endpoint. In dev we run Vite standalone and proxy that
// endpoint to the running binary (default OTLP/HTTP port 4318).
const LOCAL_BINARY_URL = process.env.MAPLE_LOCAL_URL ?? "http://127.0.0.1:4318"

export default defineConfig({
	plugins: [tsconfigPaths(), tailwindcss(), viteReact()],
	// `@maple/ui` and this app each resolve their own `react`/`react-dom` copy in
	// the monorepo; dedupe so Base UI components (Popover, etc.) share a single
	// React instance — otherwise hooks throw "more than one copy of React".
	resolve: {
		dedupe: ["react", "react-dom"],
	},
	// Emit a static SPA whose assets the Rust binary embeds via rust-embed.
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		proxy: {
			"/local": {
				target: LOCAL_BINARY_URL,
				changeOrigin: true,
			},
		},
	},
})
