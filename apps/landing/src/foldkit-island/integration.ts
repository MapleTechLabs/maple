import { fileURLToPath } from "node:url"
import { foldkit } from "@foldkit/vite-plugin"
import type { AstroIntegration } from "astro"

/** Renders `makeIsland` modules in `.astro` files and starts them under `client:*` directives. */
export const foldkitIslands = (): AstroIntegration => ({
	name: "maple:foldkit-islands",
	hooks: {
		"astro:config:setup": ({ addRenderer, command, updateConfig }) => {
			addRenderer({
				name: "foldkit-island",
				serverEntrypoint: fileURLToPath(new URL("./server.ts", import.meta.url)),
				clientEntrypoint: fileURLToPath(new URL("./client.ts", import.meta.url)),
			})
			// In dev each runtime asks the plugin for a Model preserved across reloads and stalls
			// 500 ms without it. Production builds never ask, so the plugin stays out of them.
			if (command === "dev") updateConfig({ vite: { plugins: [foldkit({ devToolsMcpPort: false })] } })
		},
	},
})
