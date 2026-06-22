import { defineConfig } from "@flue/cli/config"

// Cloudflare Workers build. With a `src/` directory present, Flue discovers
// authored modules (agents/, app.ts) from `<root>/src`.
export default defineConfig({
	target: "cloudflare",
})
