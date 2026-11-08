import type { V2ApiKey } from "@maple/domain/http/v2"

/**
 * Mirrors the v2 api-keys routes: rolling needs `api_keys:manage` and never applies to device keys (their
 * app re-mints them), and revoking needs it too, except for the viewer's own MCP and device keys.
 */
export function apiKeyRowPermissions(
	key: Pick<V2ApiKey, "kind" | "created_by" | "revoked">,
	viewer: { readonly canManageKeys: boolean; readonly userId: string | null },
): { readonly canRoll: boolean; readonly canRevoke: boolean } {
	if (key.revoked) return { canRoll: false, canRevoke: false }
	const isSelfService = key.kind === "mcp" || key.kind === "device"
	const ownKey = isSelfService && viewer.userId !== null && key.created_by === viewer.userId
	return {
		canRoll: viewer.canManageKeys && key.kind !== "device",
		canRevoke: viewer.canManageKeys || ownKey,
	}
}
