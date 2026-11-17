import type { V2ApiKey } from "@maple/domain/http/v2"

/**
 * Mirrors the v2 api-keys routes: rolling needs `api_keys:manage` and never applies to device keys (their
 * app re-mints them), and revoking needs it too, except for the viewer's own MCP and device keys. Someone
 * who may create restricted keys rolls and revokes the standard keys they created; the server still
 * refuses a roll of one that carries more than their role.
 */
export function apiKeyRowPermissions(
	key: Pick<V2ApiKey, "kind" | "created_by" | "revoked">,
	viewer: {
		readonly canManageKeys: boolean
		readonly canCreateRestricted?: boolean
		readonly userId: string | null
	},
): { readonly canRoll: boolean; readonly canRevoke: boolean } {
	if (key.revoked) return { canRoll: false, canRevoke: false }
	const isSelfService =
		key.kind === "mcp" ||
		key.kind === "device" ||
		(key.kind === "standard" && (viewer.canCreateRestricted ?? false))
	const ownKey = isSelfService && viewer.userId !== null && key.created_by === viewer.userId
	return {
		canRoll: key.kind !== "device" && (viewer.canManageKeys || (ownKey && key.kind === "standard")),
		canRevoke: viewer.canManageKeys || ownKey,
	}
}
