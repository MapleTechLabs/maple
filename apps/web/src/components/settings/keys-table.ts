import type { V2ApiKey, V2IngestKeys } from "@maple/domain/http/v2"

/**
 * A key has exactly one status. "Expiring" still works, so it lists under Active, but it carries a
 * badge and sorts to the top: an expiry nobody noticed is this page's most common failure.
 */
export type ApiKeyStatus = "active" | "expiring" | "expired" | "revoked"
export type KeyStatusFilter = "active" | "expired" | "revoked"
export type KeyTypeFilter = "all" | "ingest" | "api" | "mcp"
export type KeyType = "ingest_public" | "ingest_private" | "api" | "mcp"

const EXPIRING_WINDOW_MS = 7 * 86_400_000

/** `now` is passed in so every row in a render agrees on where the expiry boundary falls. */
export function apiKeyStatus(apiKey: Pick<V2ApiKey, "revoked" | "expires_at">, now: number): ApiKeyStatus {
	if (apiKey.revoked) return "revoked"
	const expiresAt = apiKey.expires_at === null ? null : Date.parse(apiKey.expires_at)
	if (expiresAt === null || !Number.isFinite(expiresAt)) return "active"
	if (expiresAt <= now) return "expired"
	return expiresAt - now < EXPIRING_WINDOW_MS ? "expiring" : "active"
}

/** Whether any key can still change status on the wall clock alone, so the page needs a ticking clock. */
export function hasPendingStatusBoundary(keys: ReadonlyArray<V2ApiKey>, now: number): boolean {
	return keys.some((apiKey) => {
		if (apiKey.revoked || apiKey.expires_at === null) return false
		const expiresAt = Date.parse(apiKey.expires_at)
		return Number.isFinite(expiresAt) && expiresAt > now
	})
}

export interface IngestKeyRow {
	readonly source: "ingest"
	readonly id: "ingest_public" | "ingest_private"
	readonly type: "ingest_public" | "ingest_private"
	readonly name: string
	readonly purpose: string
	readonly value: string
	readonly rotatedAt: string
	readonly status: "active"
}

export interface ApiKeyRow {
	readonly source: "api"
	readonly id: string
	readonly type: "api" | "mcp"
	readonly key: V2ApiKey
	readonly status: ApiKeyStatus
}

export type KeyRow = IngestKeyRow | ApiKeyRow

export const KEY_TYPE_LABELS = {
	ingest_public: "Ingest public",
	ingest_private: "Ingest private",
	api: "API",
	mcp: "MCP",
} satisfies Record<KeyType, string>

/**
 * One list for every credential: the org's ingest pair (null when the viewer cannot see it) first,
 * then API and MCP keys. Device keys belong to the mobile app and are not managed here.
 */
export function buildKeyRows(input: {
	readonly apiKeys: ReadonlyArray<V2ApiKey>
	readonly ingestKeys: V2IngestKeys | null
	readonly now: number
}): ReadonlyArray<KeyRow> {
	const ingest: ReadonlyArray<IngestKeyRow> =
		input.ingestKeys === null
			? []
			: [
					{
						source: "ingest",
						id: "ingest_public",
						type: "ingest_public",
						name: "Public ingest key",
						purpose: "Browser and client-side SDKs",
						value: input.ingestKeys.public_key,
						rotatedAt: input.ingestKeys.public_rotated_at,
						status: "active",
					},
					{
						source: "ingest",
						id: "ingest_private",
						type: "ingest_private",
						name: "Private ingest key",
						purpose: "Server-side SDKs and collectors",
						value: input.ingestKeys.private_key,
						rotatedAt: input.ingestKeys.private_rotated_at,
						status: "active",
					},
				]
	const api = input.apiKeys.flatMap((key): ReadonlyArray<ApiKeyRow> => {
		if (key.kind === "device") return []
		return [
			{
				source: "api",
				id: key.id,
				type: key.kind === "mcp" ? "mcp" : "api",
				key,
				status: apiKeyStatus(key, input.now),
			},
		]
	})
	return [...ingest, ...api]
}

const statusMatches = (row: KeyRow, status: KeyStatusFilter): boolean =>
	status === "active" ? row.status === "active" || row.status === "expiring" : row.status === status

const typeMatches = (row: KeyRow, type: KeyTypeFilter): boolean => {
	if (type === "all") return true
	if (type === "ingest") return row.source === "ingest"
	return row.type === type
}

const searchText = (row: KeyRow): string =>
	(row.source === "ingest"
		? [row.name, row.purpose, KEY_TYPE_LABELS[row.type]]
		: [row.key.name, row.key.description ?? "", row.key.key_prefix, row.key.created_by_email ?? ""]
	)
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
		// Ingest keys lead, then keys about to stop working; everything else keeps list order.
		.map((row, index) => ({ row, index }))
		.sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
		.map(({ row }) => row)
	const count = (type: KeyTypeFilter) => inStatus.filter((row) => typeMatches(row, type)).length
	const countStatus = (status: KeyStatusFilter) => rows.filter((row) => statusMatches(row, status)).length
	return {
		visible,
		typeCounts: { all: count("all"), ingest: count("ingest"), api: count("api"), mcp: count("mcp") },
		statusCounts: {
			active: countStatus("active"),
			expired: countStatus("expired"),
			revoked: countStatus("revoked"),
		},
	}
}

const rank = (row: KeyRow): number => (row.source === "ingest" ? 0 : row.status === "expiring" ? 1 : 2)

/**
 * What a row's key can do, in words: "Send telemetry" for ingest keys, "Full access" for unscoped
 * keys, otherwise "Write: alerts · Read: dashboards, metrics". Write implies read, so a family
 * with write access is not repeated under Read.
 */
export function keyAccessSummary(row: KeyRow): string {
	if (row.source === "ingest") return "Send telemetry"
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

/**
 * How an API/MCP key load failure shows. Admins always get the ingest pair, so a failed list must
 * not hide behind those rows: it replaces the table only when nothing else could render.
 */
export function apiKeysFailureDisplay(input: {
	readonly apiKeysFailed: boolean
	readonly rows: ReadonlyArray<KeyRow>
}): "none" | "inline" | "replace" {
	if (!input.apiKeysFailed) return "none"
	return input.rows.length === 0 ? "replace" : "inline"
}
