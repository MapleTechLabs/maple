export type McpClient = "claude-code" | "cursor" | "windsurf" | "other"

export const MCP_CLIENTS: ReadonlyArray<{ readonly id: McpClient; readonly label: string }> = [
	{ id: "claude-code", label: "Claude Code" },
	{ id: "cursor", label: "Cursor" },
	{ id: "windsurf", label: "Windsurf" },
	{ id: "other", label: "Other" },
]

export const isMcpClient = (value: unknown): value is McpClient =>
	MCP_CLIENTS.some((client) => client.id === value)

const authHeaders = (apiKey: string | undefined) =>
	apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined

/**
 * The `mcpServers` entry each client reads. Claude Code needs `type: "http"`, Windsurf names the
 * URL `serverUrl`, Cursor infers the transport from `url`. An MCP key adds a bearer header.
 */
export function mcpClientConfig(client: McpClient, endpoint: string, apiKey?: string): string {
	const server =
		client === "windsurf"
			? { serverUrl: endpoint, ...authHeaders(apiKey) }
			: client === "cursor"
				? { url: endpoint, ...authHeaders(apiKey) }
				: { type: "http", url: endpoint, ...authHeaders(apiKey) }
	return JSON.stringify({ mcpServers: { maple: server } }, null, 2)
}

export function claudeCodeCommand(endpoint: string, apiKey?: string): string {
	const base = `claude mcp add --transport http maple ${endpoint}`
	return apiKey ? `${base} \\\n  --header "Authorization: Bearer ${apiKey}"` : base
}
