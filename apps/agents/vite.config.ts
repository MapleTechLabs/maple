import path from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Pin a single @tanstack/db copy (the runtime + UI must share one instance for
// live queries to work across the agents-runtime client and useLiveQuery).
const tanstackDbPath = path.resolve(import.meta.dirname, "node_modules/@tanstack/db")

export default defineConfig({
	root: "src/ui",
	plugins: [react()],
	resolve: {
		alias: {
			"@tanstack/db": tanstackDbPath,
		},
	},
	server: {
		port: 5175,
		open: false,
		// Proxy the runtime app's REST API (rooms / messages / spawn) to :4700.
		proxy: {
			"/api": "http://localhost:4700",
		},
	},
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
	},
})
