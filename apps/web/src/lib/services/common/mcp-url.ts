import { Option, String as Str } from "effect"

const configuredMcpUrl = Option.map(Option.fromNullishOr(import.meta.env.VITE_MCP_URL), Str.trim).pipe(
	Option.getOrUndefined,
)
// Not `VITE_API_BASE_URL`: MCP clients need the API's own origin for OAuth discovery.
const apiPublicUrl = Option.map(
	Option.fromNullishOr(import.meta.env.VITE_API_PUBLIC_URL ?? import.meta.env.VITE_API_BASE_URL),
	Str.trim,
).pipe(Option.getOrUndefined)

export const mcpUrl =
	configuredMcpUrl && configuredMcpUrl.length > 0
		? Str.replace(/\/$/, "")(configuredMcpUrl)
		: apiPublicUrl && apiPublicUrl.length > 0
			? Str.replace(/\/$/, "")(apiPublicUrl)
			: "http://localhost:3472"
