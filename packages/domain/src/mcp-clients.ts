// Who called an MCP server, from `user_agent.original`: the spec has no per-call client attribute
// (`clientInfo` rides on `initialize` only). Families group versions, so `claude-code/2.1.314 (...)`
// is "Claude Code". The warehouse classifies with the same list (`ch/queries/mcp.ts`).

export const MCP_CLIENT_KINDS = ["agent", "script", "internal", "unknown"] as const
export type McpClientKind = (typeof MCP_CLIENT_KINDS)[number]

export type McpClient = Readonly<{ name: string; kind: McpClientKind }>

/** Ordered, first match wins: a lower-case prefix of the user agent. */
export const KNOWN_MCP_CLIENTS: ReadonlyArray<Readonly<{ prefix: string } & McpClient>> = [
	{ prefix: "claude-code/", name: "Claude Code", kind: "agent" },
	{ prefix: "claude-user", name: "Claude", kind: "agent" },
	{ prefix: "openai-mcp/", name: "Codex", kind: "agent" },
	{ prefix: "cursor/", name: "Cursor", kind: "agent" },
	{ prefix: "windsurf/", name: "Windsurf", kind: "agent" },
	{ prefix: "vscode/", name: "VS Code", kind: "agent" },
	{ prefix: "omp/", name: "omp", kind: "agent" },
	{ prefix: "curl/", name: "curl", kind: "script" },
	{ prefix: "bun/", name: "Bun", kind: "script" },
	{ prefix: "undici", name: "Node (undici)", kind: "script" },
	{ prefix: "node", name: "Node", kind: "script" },
	{ prefix: "python-httpx/", name: "Python (httpx)", kind: "script" },
	{ prefix: "python-requests/", name: "Python (requests)", kind: "script" },
	{ prefix: "aiohttp/", name: "Python (aiohttp)", kind: "script" },
	{ prefix: "go-http-client/", name: "Go", kind: "script" },
	// Maple's own callers of its MCP server.
	{ prefix: "executor", name: "executor", kind: "internal" },
	{ prefix: "estate-console/", name: "estate-console", kind: "internal" },
	{ prefix: "preview-verifier/", name: "preview-verifier", kind: "internal" },
]

export const UNKNOWN_MCP_CLIENT = "unknown"

/** An unrecognised `product/version` is named by its product token. */
export const MCP_CLIENT_TOKEN_PATTERN = "^[^/ ]+"

/** Reads the raw string, untrimmed, exactly as the SQL copy does; no product token is `unknown`. */
export const mcpClientOf = (userAgent: string): McpClient => {
	const lower = userAgent.toLowerCase()
	const known = KNOWN_MCP_CLIENTS.find((client) => lower.startsWith(client.prefix))
	if (known !== undefined) return { name: known.name, kind: known.kind }
	return {
		name: new RegExp(MCP_CLIENT_TOKEN_PATTERN).exec(userAgent)?.[0] ?? UNKNOWN_MCP_CLIENT,
		kind: "unknown",
	}
}
