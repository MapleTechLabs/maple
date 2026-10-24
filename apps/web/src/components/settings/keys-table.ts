import type { V2ApiKey } from "@maple/domain/http/v2"

/**
 * A key has exactly one status. "Expiring" still works, so it lists under Active, but it carries a
 * badge and sorts to the top: an expiry nobody noticed is this page's most common failure.
 */
export type ApiKeyStatus = "active" | "expiring" | "expired" | "revoked"
export type KeyStatusFilter = "active" | "expired" | "revoked"
export type KeyTypeFilter = "all" | "api" | "mcp"
export type KeyType = "api" | "mcp"

const EXPIRING_WINDOW_MS = 7 * 86_400_000

/** `now` is passed in so every row in a render agrees on where the expiry boundary falls. */
export function apiKeyStatus(apiKey: Pick<V2ApiKey, "revoked" | "expires_at">, now: number): ApiKeyStatus {
	if (apiKey.revoked) return "revoked"
	const expiresAt = apiKey.expires_at === null ? null : Date.parse(apiKey.expires_at)
	if (expiresAt === null || !Number.isFinite(expiresAt)) return "active"
	if (expiresAt <= now) return "expired"
	return expiresAt - now < EXPIRING_WINDOW_MS ? "expiring" : "active"
}

export interface KeyRow {
	readonly id: string
	readonly type: "api" | "mcp"
	readonly key: V2ApiKey
	readonly status: ApiKeyStatus
}

export const KEY_TYPE_LABELS = {
	api: "API",
	mcp: "MCP",
} satisfies Record<KeyType, string>

/** API and MCP keys. Device keys list apart, in `buildDeviceKeyRows`. */
export function buildKeyRows(input: {
	readonly apiKeys: ReadonlyArray<V2ApiKey>
	readonly now: number
}): ReadonlyArray<KeyRow> {
	return input.apiKeys.flatMap((key): ReadonlyArray<KeyRow> => {
		if (key.kind === "device") return []
		return [
			{
				id: key.id,
				type: key.kind === "mcp" ? "mcp" : "api",
				key,
				status: apiKeyStatus(key, input.now),
			},
		]
	})
}

/**
 * The live credentials phones mint for their Home Screen widgets, newest first. Revoked and
 * expired ones are left out: every re-mint retires the previous key, so they pile up by design.
 */
export function buildDeviceKeyRows(input: {
	readonly apiKeys: ReadonlyArray<V2ApiKey>
	readonly now: number
}): ReadonlyArray<KeyRow> {
	return input.apiKeys
		.filter((key) => key.kind === "device")
		.map((key): KeyRow => ({ id: key.id, type: "api", key, status: apiKeyStatus(key, input.now) }))
		.filter((row) => row.status === "active" || row.status === "expiring")
		.toSorted((a, b) => Date.parse(b.key.created_at) - Date.parse(a.key.created_at))
}

const statusMatches = (row: KeyRow, status: KeyStatusFilter): boolean =>
	status === "active" ? row.status === "active" || row.status === "expiring" : row.status === status

const typeMatches = (row: KeyRow, type: KeyTypeFilter): boolean => type === "all" || row.type === type

const searchText = (row: KeyRow): string =>
	[row.key.name, row.key.description ?? "", row.key.key_prefix, row.key.created_by_email ?? ""]
		.join(" ")
		.toLowerCase()

export interface KeyRowFilter {
	readonly type: KeyTypeFilter
	readonly status: KeyStatusFilter
	readonly search: string
}

/**
 * Rows for the current filters plus the per-type and per-status counts the toolbar shows. Type
 * counts are within the selected status and ignore the search, so a chip never reads 0 while typing.
 */
export function filterKeyRows(
	rows: ReadonlyArray<KeyRow>,
	filter: KeyRowFilter,
): {
	readonly visible: ReadonlyArray<KeyRow>
	readonly typeCounts: Record<KeyTypeFilter, number>
	readonly statusCounts: Record<KeyStatusFilter, number>
} {
	const inStatus = rows.filter((row) => statusMatches(row, filter.status))
	const needle = filter.search.trim().toLowerCase()
	const visible = inStatus
		.filter((row) => typeMatches(row, filter.type))
		.filter((row) => needle.length === 0 || searchText(row).includes(needle))
		// Keys about to stop working lead; everything else keeps list order.
		.map((row, index) => ({ row, index }))
		.sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
		.map(({ row }) => row)
	const count = (type: KeyTypeFilter) => inStatus.filter((row) => typeMatches(row, type)).length
	const countStatus = (status: KeyStatusFilter) => rows.filter((row) => statusMatches(row, status)).length
	return {
		visible,
		typeCounts: { all: count("all"), api: count("api"), mcp: count("mcp") },
		statusCounts: {
			active: countStatus("active"),
			expired: countStatus("expired"),
			revoked: countStatus("revoked"),
		},
	}
}

const rank = (row: KeyRow): number => (row.status === "expiring" ? 0 : 1)

/**
 * What a row's key can do, in words: "MCP tools" for MCP keys, "Full access" for unscoped
 * keys, otherwise "Write: alerts · Read: dashboards, metrics". Write implies read, so a family
 * with write access is not repeated under Read.
 */
export function keyAccessSummary(row: KeyRow): string {
	if (row.type === "mcp") return "MCP tools"
	if (row.key.scopes === null) return "Full access"
	const family = (scope: string) => scope.replace(/:(read|write)$/, "").replaceAll("_", " ")
	const writes = row.key.scopes.filter((s) => s.endsWith(":write")).map(family)
	const reads = row.key.scopes
		.filter((s) => s.endsWith(":read"))
		.map(family)
		.filter((f) => !writes.includes(f))
	return [
		writes.length > 0 ? `Write: ${writes.join(", ")}` : null,
		reads.length > 0 ? `Read: ${reads.join(", ")}` : null,
	]
		.filter((part) => part !== null)
		.join(" · ")
}
