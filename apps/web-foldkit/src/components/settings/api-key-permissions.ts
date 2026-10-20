import type { V2ApiKey } from "@maple/domain/http/v2"

/**
 * Mirrors the v2 api-keys routes: rolling is admin-only, and revoking is admin-only except
 * that a member may revoke an MCP key they created, since members can mint those.
 */
export function apiKeyRowPermissions(
	key: Pick<V2ApiKey, "kind" | "created_by" | "revoked">,
	viewer: { readonly isAdmin: boolean; readonly userId: string | null },
): { readonly canRoll: boolean; readonly canRevoke: boolean } {
	if (key.revoked) return { canRoll: false, canRevoke: false }
	const ownMcpKey = key.kind === "mcp" && viewer.userId !== null && key.created_by === viewer.userId
	return { canRoll: viewer.isAdmin, canRevoke: viewer.isAdmin || ownMcpKey }
}
