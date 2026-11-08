import type { V2ApiKey } from "@maple/domain/http/v2"
import { Array as Arr, Order, String as Str } from "effect"

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
	return Arr.flatMap(input.apiKeys, (key): ReadonlyArray<KeyRow> => {
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
	return Arr.sort(
		Arr.filter(
			Arr.map(
				Arr.filter(input.apiKeys, (key) => key.kind === "device"),
				(key): KeyRow => ({ id: key.id, type: "api", key, status: apiKeyStatus(key, input.now) }),
			),
			(row) => row.status === "active" || row.status === "expiring",
		),
		Order.flip(Order.mapInput(Order.Number, (row: KeyRow) => Date.parse(row.key.created_at))),
	)
}

const statusMatches = (row: KeyRow, status: KeyStatusFilter): boolean =>
	status === "active" ? row.status === "active" || row.status === "expiring" : row.status === status

const typeMatches = (row: KeyRow, type: KeyTypeFilter): boolean => type === "all" || row.type === type

const searchText = (row: KeyRow): string =>
	Str.toLowerCase(
		Arr.join(
			[row.key.name, row.key.description ?? "", row.key.key_prefix, row.key.created_by_email ?? ""],
			" ",
		),
	)

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
	const inStatus = Arr.filter(rows, (row) => statusMatches(row, filter.status))
	const needle = Str.toLowerCase(Str.trim(filter.search))
	const visible = Arr.map(
		Arr.map(
			Arr.filter(
				Arr.filter(inStatus, (row) => typeMatches(row, filter.type)),
				(row) => needle.length === 0 || Str.includes(needle)(searchText(row)),
			),
			(row, index) => ({ row, index }),
		).sort((a, b) => (rank(a.row) !== rank(b.row) ? rank(a.row) - rank(b.row) : a.index - b.index)),
		({ row }) => row,
	)
	const count = (type: KeyTypeFilter) => Arr.filter(inStatus, (row) => typeMatches(row, type)).length
	const countStatus = (status: KeyStatusFilter) =>
		Arr.filter(rows, (row) => statusMatches(row, status)).length
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
	const family = (scope: string) => Str.replaceAll("_", " ")(Str.replace(/:(read|write)$/, "")(scope))
	const writes = Arr.map(
		Arr.filter(row.key.scopes, (s) => Str.endsWith(":write")(s)),
		family,
	)
	const reads = Arr.filter(
		Arr.map(
			Arr.filter(row.key.scopes, (s) => Str.endsWith(":read")(s)),
			family,
		),
		(f) => !writes.includes(f),
	)
	return Arr.join(
		Arr.filter(
			[
				writes.length > 0 ? `Write: ${Arr.join(writes, ", ")}` : null,
				reads.length > 0 ? `Read: ${Arr.join(reads, ", ")}` : null,
			],
			(part) => part !== null,
		),
		" · ",
	)
}
