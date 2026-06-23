import { connectMcpServer, type McpServerConnection } from "@flue/runtime"
import type { ChatFlueEnv } from "./env.ts"

/** Prefix `connectMcpServer` adapts MCP tool names with: `mcp__<server>__<tool>`. */
const MCP_PREFIX = "mcp__maple__"

/** Strip the `mcp__maple__` prefix to recover the registry tool name. */
export const baseToolName = (name: string): string =>
	name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name

/** Keep only the tools whose base (unprefixed) name is in the allowlist. */
export const filterMcpTools = <T extends { name: string }>(
	tools: readonly T[],
	allowlist: ReadonlySet<string>,
): T[] => tools.filter((tool) => allowlist.has(baseToolName(tool.name)))

/** Default MCP request timeout (ms): an unreachable endpoint fails fast rather than hanging the turn. */
export const MCP_DEFAULT_TIMEOUT_MS = 12_000

export interface ConnectMapleMcpOptions {
	/** If set, keep only tools whose base name is in this allowlist (e.g. the triage subset). */
	allowlist?: ReadonlySet<string>
	/** MCP request timeout in ms. Defaults to {@link MCP_DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number
}

/**
 * Connect to Maple's MCP server with internal-service auth. The tenant rides
 * out-of-band in `x-org-id` (never trusted from model/tool output); the contract
 * is apps/api/src/mcp/lib/resolve-tenant.ts. Tools arrive adapted as
 * `mcp__maple__<tool>`; an optional `allowlist` narrows them by base name.
 *
 * The caller owns the returned connection's lifecycle and must `close()` it.
 */
export const connectMapleMcp = async (
	env: ChatFlueEnv,
	orgId: string,
	options: ConnectMapleMcpOptions = {},
): Promise<McpServerConnection> => {
	// Fail fast rather than sending `Bearer maple_svc_` (empty): an empty token
	// would match an empty server-side INTERNAL_SERVICE_TOKEN via the constant-time
	// compare in apps/api resolve-tenant.ts. Callers already tolerate a throw.
	const token = env.INTERNAL_SERVICE_TOKEN
	if (!token) throw new Error("INTERNAL_SERVICE_TOKEN is not configured")

	const maple = await connectMcpServer("maple", {
		url: new URL("/mcp", env.MAPLE_API_URL).toString(),
		transport: "streamable-http",
		headers: {
			Authorization: `Bearer maple_svc_${token}`,
			"x-org-id": orgId,
		},
		timeoutMs: options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
	})

	if (!options.allowlist) return maple
	return { ...maple, tools: filterMcpTools(maple.tools, options.allowlist) }
}
