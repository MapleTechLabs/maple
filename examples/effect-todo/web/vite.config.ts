import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const webRoot = import.meta.dirname

export default defineConfig({
	// `index.html` and `src/` live in this `web/` dir.
	root: webRoot,
	// `shared/api.ts` is a sibling of `web/` inside the package — allow Vite to
	// serve files from the package root so the shared schema import resolves.
	server: {
		port: 4501,
		fs: { allow: [path.resolve(webRoot, "..")] },
	},
	plugins: [tailwindcss(), viteReact()],
})
