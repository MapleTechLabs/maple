// Pure pieces of the Search Console importer: Google's Pacific days, the head/backfill plan for a
// site, the three grains and their dimensions, and Search Analytics rows to `search_console_daily`.
import {
	addDays,
	completeThrough,
	HISTORY_MONTHS,
	historyFloor,
	pacificToday,
} from "@maple/domain/search-console"
import type { SearchConsoleDailyRow } from "@maple/domain/tinybird"
import { DateTime, Array as Arr, String as Str } from "effect"
import type { SearchAnalyticsDimension, SearchAnalyticsRow } from "./client"

export const SEARCH_CONSOLE_DATASOURCE = "search_console_daily"

/** v1 imports web search only; the column leaves room for image, video and news. */
export const SEARCH_TYPE_WEB = "web"

/** Days re-fetched behind the head watermark: Google keeps revising them for about three days. */
export const HEAD_REFETCH_DAYS = 3
/** Days one import covers at most: the first head window, a catch-up step and a backfill chunk. */
export const CHUNK_DAYS = 14

/**
 * `site` is the property's true totals; `page` adds the page; `query` adds the query, where Google
 * drops anonymized queries. Each is its own import because the totals differ per dimension set.
 */
export const GRAINS = [
	{ grain: "site", dimensions: ["date", "country", "device"] },
	// No country/device: Google drops anonymized traffic whenever page is combined with them.
	{ grain: "page", dimensions: ["date", "page"] },
	{ grain: "query", dimensions: ["date", "page", "query", "country", "device"] },
] as const satisfies ReadonlyArray<{
	readonly grain: string
	readonly dimensions: ReadonlyArray<SearchAnalyticsDimension>
}>

export type SearchConsoleGrain = (typeof GRAINS)[number]["grain"]

const DAY_MS = 86_400_000

export { addDays, completeThrough, HISTORY_MONTHS, historyFloor, pacificToday }

const dayStart = (day: string) => DateTime.makeUnsafe(`${day}T00:00:00Z`)

/** Inclusive day count of a range. */
export const daysBetween = (startDate: string, endDate: string): number =>
	Math.round(
		(DateTime.toEpochMillis(dayStart(endDate)) - DateTime.toEpochMillis(dayStart(startDate))) / DAY_MS,
	) + 1

const minDay = (a: string, b: string) => (a < b ? a : b)
const maxDay = (a: string, b: string) => (a > b ? a : b)

export interface SiteImportState {
	readonly watermarkDate: string | null
	readonly backfillDate: string | null
	readonly lastSyncedAt: number | null
}

export type ImportPlan =
	| { readonly mode: "head"; readonly startDate: string; readonly endDate: string }
	| { readonly mode: "backfill"; readonly startDate: string; readonly endDate: string }
	| { readonly mode: "idle" }

/**
 * One import per site per tick. HEAD while it is new, stale (`headIntervalMs` since the last head
 * import) or more than the refetch window behind; otherwise one BACKFILL chunk until the floor.
 */
export const planImport = (state: SiteImportState, now: number, headIntervalMs: number): ImportPlan => {
	const today = pacificToday(now)
	if (state.watermarkDate === null) {
		return { mode: "head", startDate: addDays(today, -(CHUNK_DAYS - 1)), endDate: today }
	}
	const floor = historyFloor(today)
	// A head left far behind restarts at Google's floor: older days no longer answer.
	const refetchFrom = maxDay(floor, addDays(state.watermarkDate, -HEAD_REFETCH_DAYS))
	const behind = state.watermarkDate < addDays(today, -HEAD_REFETCH_DAYS)
	const stale = state.lastSyncedAt === null || now - state.lastSyncedAt >= headIntervalMs
	if (behind || stale) {
		return {
			mode: "head",
			startDate: refetchFrom,
			endDate: minDay(today, addDays(refetchFrom, CHUNK_DAYS - 1)),
		}
	}
	if (state.backfillDate === null || state.backfillDate <= floor) return { mode: "idle" }
	const endDate = addDays(state.backfillDate, -1)
	return { mode: "backfill", startDate: maxDay(floor, addDays(endDate, -(CHUNK_DAYS - 1))), endDate }
}

/** Epoch ms as the warehouse's `DateTime64(3)` literal, UTC. */
export const toWarehouseDateTime64 = (epochMs: number): string =>
	Str.replace("T", " ")(Str.slice(0, 23)(DateTime.formatIso(DateTime.makeUnsafe(epochMs))))

/**
 * One Search Analytics row as a datasource row. `keys` follow the grain's dimensions; a grain
 * without a page or query writes ''. Clicks and impressions are whole counts in Google's answer.
 */
export const toDailyRow = (
	context: {
		readonly orgId: string
		readonly siteUrl: string
		readonly grain: SearchConsoleGrain
		readonly dimensions: ReadonlyArray<SearchAnalyticsDimension>
		readonly ingestedAt: string
	},
	row: SearchAnalyticsRow,
): SearchConsoleDailyRow => {
	const keys = row.keys ?? []
	const key = (dimension: SearchAnalyticsDimension) => {
		const index = context.dimensions.indexOf(dimension)
		return index === -1 ? "" : (keys[index] ?? "")
	}
	const impressions = Math.round(row.impressions)
	return {
		OrgId: context.orgId,
		SiteUrl: context.siteUrl,
		Grain: context.grain,
		SearchType: SEARCH_TYPE_WEB,
		Date: `${key("date")} 00:00:00`,
		Page: key("page"),
		Query: key("query"),
		Country: Str.toLowerCase(key("country")),
		Device: Str.toLowerCase(key("device")),
		Clicks: Math.round(row.clicks),
		Impressions: impressions,
		// Google's position is impression-weighted, so the sum re-aggregates as sum / impressions.
		PositionSum: row.position * impressions,
		IngestedAt: context.ingestedAt,
	}
}

export const toDailyRows = (
	context: Parameters<typeof toDailyRow>[0],
	rows: ReadonlyArray<SearchAnalyticsRow>,
): ReadonlyArray<SearchConsoleDailyRow> => Arr.map(rows, (row) => toDailyRow(context, row))
