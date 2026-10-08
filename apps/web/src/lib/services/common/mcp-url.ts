const configuredMcpUrl = import.meta.env.VITE_MCP_URL?.trim()
// The public URL, not `VITE_API_BASE_URL`: that can be this app's same-origin
// proxy, and MCP clients need the API's own origin for OAuth discovery.
const apiPublicUrl = (import.meta.env.VITE_API_PUBLIC_URL ?? import.meta.env.VITE_API_BASE_URL)?.trim()

export const mcpUrl =
	configuredMcpUrl && configuredMcpUrl.length > 0
		? configuredMcpUrl.replace(/\/$/, "")
		: apiPublicUrl && apiPublicUrl.length > 0
			? apiPublicUrl.replace(/\/$/, "")
			: "http://localhost:3472"
