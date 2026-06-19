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

export interface ConnectMapleMcpOptions {
	/** If set, keep only tools whose base name is in this allowlist (e.g. the triage subset). */
	allowlist?: ReadonlySet<string>
	/** MCP request timeout in ms. Defaults to 12s so an unreachable endpoint fails fast. */
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
	const maple = await connectMcpServer("maple", {
		url: new URL("/mcp", env.MAPLE_API_URL).toString(),
		transport: "streamable-http",
		headers: {
			Authorization: `Bearer maple_svc_${env.INTERNAL_SERVICE_TOKEN ?? ""}`,
			"x-org-id": orgId,
		},
		timeoutMs: options.timeoutMs ?? 12_000,
	})

	if (!options.allowlist) return maple
	return { ...maple, tools: filterMcpTools(maple.tools, options.allowlist) }
}
