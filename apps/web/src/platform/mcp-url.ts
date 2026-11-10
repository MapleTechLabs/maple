import { envUrl } from "./env-url"

// Not `VITE_API_BASE_URL` first: MCP clients need the API's own origin for OAuth discovery.
export const mcpUrl =
	envUrl(import.meta.env.VITE_MCP_URL) ??
	envUrl(import.meta.env.VITE_API_PUBLIC_URL ?? import.meta.env.VITE_API_BASE_URL) ??
	"http://localhost:3472"
