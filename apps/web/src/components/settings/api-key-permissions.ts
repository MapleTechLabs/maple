import type { V2ApiKey } from "@maple/domain/http/v2"

/**
 * Mirrors the v2 api-keys routes: rolling is admin-only and never applies to device keys (their
 * app re-mints them), and revoking is admin-only except for the viewer's own MCP and device keys.
 */
export function apiKeyRowPermissions(
	key: Pick<V2ApiKey, "kind" | "created_by" | "revoked">,
	viewer: { readonly isAdmin: boolean; readonly userId: string | null },
): { readonly canRoll: boolean; readonly canRevoke: boolean } {
	if (key.revoked) return { canRoll: false, canRevoke: false }
	const isSelfService = key.kind === "mcp" || key.kind === "device"
	const ownKey = isSelfService && viewer.userId !== null && key.created_by === viewer.userId
	return { canRoll: viewer.isAdmin && key.kind !== "device", canRevoke: viewer.isAdmin || ownKey }
}
