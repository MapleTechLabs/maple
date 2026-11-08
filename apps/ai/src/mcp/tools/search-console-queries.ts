import { Effect, Schema, Array as Arr, String as Str } from "effect"
import { SearchConsoleTopQueriesRequest, SearchConsoleOverviewRequest } from "@maple/domain/http"
import {
	SearchConsoleDevice,
	SearchConsoleQueriesOutput,
	SearchConsoleToolSort,
} from "@maple/domain/mcp-outputs"
import type { McpToolRegistrar } from "./types"
import { formatDelta, formatNumber, formatPercent, formatPointsDelta, truncate } from "../lib/format"
import * as P from "../lib/params"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import {
	daysPastDataThrough,
	resolveSearchConsoleSite,
	searchConsoleReadHandlers,
	searchConsoleReads,
	windowEndingAtDataThrough,
} from "../lib/search-console"
import { doc, type NextCall } from "../lib/tool-doc"

const TOOL = "search_console_queries"
/** Google's 28-day default; it keeps 16 months, the comparison reads twice the window. */
const WINDOW = P.timeWindow({ defaultHours: 28 * 24, maxHours: 365 * 24 })
const MAX_LIMIT = 200

type Output = typeof SearchConsoleQueriesOutput.Type

const sqlString = (value: string): string =>
	`'${Str.replace(/'/g, "\\'")(Str.replace(/\\/g, "\\\\")(value))}'`

/** Daily clicks, impressions and position of one query, from each day's newest import only. */
export const queryTrendSql = (siteUrl: string, query: string): string => {
	const where = `WHERE $__orgFilter AND SiteUrl = ${sqlString(siteUrl)} AND Grain = 'query' AND Date >= toStartOfDay($__startTime) AND Date <= $__endTime`
	return (
		"SELECT Date, sum(Clicks) AS clicks, sum(Impressions) AS impressions, " +
		"round(sum(PositionSum) / sum(Impressions), 1) AS position FROM search_console_daily " +
		`${where} AND Query = ${sqlString(query)} ` +
		`AND (Date, IngestedAt) IN (SELECT Date, max(IngestedAt) FROM search_console_daily ${where} GROUP BY Date) ` +
		"GROUP BY Date ORDER BY Date"
	)
}

export const positionText = (current: number, previous: number): string =>
	current === 0
		? "-"
		: previous === 0
			? current.toFixed(1)
			: `${current.toFixed(1)} (was ${previous.toFixed(1)})`

/**
 * The property's totals with their change. Like the dashboard, nothing shows a change without
 * impressions this period, and a metric shows none when its previous value is 0.
 */
export const totalsFields = (totals: Output["totals"]): ReadonlyArray<readonly [string, string]> => {
	const hasDeltas = totals.impressions > 0
	const withChange = (
		text: string,
		current: number,
		previous: number,
		change: (current: number, previous: number) => string,
	) => (hasDeltas && previous !== 0 ? `${text} (${change(current, previous)})` : text)
	return [
		[
			"Clicks",
			withChange(formatNumber(totals.clicks), totals.clicks, totals.previous.clicks, formatDelta),
		],
		[
			"Impressions",
			withChange(
				formatNumber(totals.impressions),
				totals.impressions,
				totals.previous.impressions,
				formatDelta,
			),
		],
		["CTR", withChange(formatPercent(totals.ctr), totals.ctr, totals.previous.ctr, formatPointsDelta)],
		["Avg position", hasDeltas ? positionText(totals.position, totals.previous.position) : "-"],
	]
}

export const lagNotice = (output: {
	readonly site: Output["site"]
	readonly timeRange: Output["timeRange"]
}): ReadonlyArray<string> => {
	const days = daysPastDataThrough(output.timeRange.end, output.site.dataThrough)
	return days === 0
		? []
		: [
				`Data is complete through ${output.site.dataThrough ?? "?"}, so the last ${days} day${days === 1 ? "" : "s"} of this window are left out (Google reports with a 2 to 3 day lag and today is partial); totals and deltas cover the window up to then. Omit end_time to end on the last complete day.`,
			]
}

export function registerSearchConsoleQueriesTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Search Console Queries",
		description:
			"Google search queries that bring people to the site, from the org's connected Google Search Console: clicks, impressions, CTR and average position per query, with the property's totals and their change against the previous period of the same length. Optional page, country and device filters. Google reports with a 2 to 3 day lag; with no window given it ends on the last complete day, and reads never count a later, partial day. Landing pages joined with Maple sessions, bounce rate and conversions: search_console_pages.",
		parameters: Schema.Struct({
			site: P.optionalText(
				"Search Console property, e.g. `sc-domain:example.com` or `https://example.com/` (a bare host matches too). Default: the org's first enabled property with data",
			),
			...WINDOW.fields,
			sort: P.optionalOneOf(
				SearchConsoleToolSort.literals,
				"Order of the queries (default clicks); position sorts best (lowest) first",
			),
			page: P.optionalText(
				"Only queries that landed on this full page URL, e.g. `https://example.com/pricing`",
			),
			country: P.optionalText("Only searches from this country: ISO 3166 alpha-3, e.g. `usa`, `deu`"),
			device: P.optionalOneOf(SearchConsoleDevice.literals, "Only searches from this device type"),
			limit: P.limit({ default: 25, max: MAX_LIMIT, noun: "queries" }),
		}),
		output: SearchConsoleQueriesOutput,
		hints: { readOnly: true },
		phrases: ["Reading Search Console queries", "Checking search queries"],
		handler: Effect.fn("McpTool.searchConsoleQueries")(function* (params) {
			const site = yield* resolveSearchConsoleSite(TOOL, params.site)
			const { st, et } = yield* WINDOW.resolve(
				windowEndingAtDataThrough(params, site.state.dataThrough),
				TOOL,
			)
			const sort = params.sort ?? "clicks"
			const country = params.country === undefined ? undefined : Str.toLowerCase(params.country)
			// The reads stop at the last complete day even when end_time runs past it.
			const window = {
				siteUrl: site.row.siteUrl,
				startTime: st,
				endTime: et,
				...(site.state.dataThrough === null
					? undefined
					: { completeThrough: site.state.dataThrough }),
			}
			const reads = yield* searchConsoleReads
			const tenant = yield* CurrentMcpTenant
			const [totals, rows] = yield* Effect.all(
				[
					reads.overview(tenant, new SearchConsoleOverviewRequest(window)),
					reads.topQueries(
						tenant,
						new SearchConsoleTopQueriesRequest({
							...window,
							sortBy: sort,
							// One extra row says whether more exist.
							limit: params.limit + 1,
							...(params.page === undefined ? undefined : { page: params.page }),
							...(country === undefined ? undefined : { country }),
							...(params.device === undefined ? undefined : { device: params.device }),
						}),
					),
				],
				{ concurrency: 2 },
			).pipe(Effect.catchTags(searchConsoleReadHandlers(TOOL)))
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
			return {
				site: site.state,
				timeRange: { start: st, end: et },
				sort,
				...(params.page === undefined ? undefined : { page: params.page }),
				...(country === undefined ? undefined : { country }),
				...(params.device === undefined ? undefined : { device: params.device }),
				totals,
				queries: rows.slice(0, params.limit),
				truncated: rows.length > params.limit,
			}
		}),
		render: (output) => {
			const { totals, queries, site } = output
			const filtered =
				output.page !== undefined || output.country !== undefined || output.device !== undefined
			const top = queries[0]
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			const next: Array<NextCall> = [
				doc.next(
					"search_console_pages",
					{ site: site.siteUrl, ...window },
					"landing pages with Maple sessions, bounce rate and conversions",
				),
				...(top === undefined
					? []
					: [
							doc.next(
								"run_sql",
								{ sql: queryTrendSql(site.siteUrl, top.query), ...window },
								`the daily trend of "${truncate(top.query, 40)}"`,
							),
						]),
			]
			return {
				title: `Search Console queries: ${site.siteUrl}`,
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Data through", site.dataThrough ?? undefined],
					["Sort", output.sort],
					["Page", output.page],
					["Country", output.country],
					["Device", output.device],
				],
				...(site.lastError === null
					? undefined
					: { warnings: [`Last import failed: ${site.lastError}`] }),
				...(queries.length === 0
					? {
							empty: {
								message: "No search queries in this window.",
								hints: [
									filtered
										? "The filters may be too narrow; page must be the full URL Google reports."
										: "Google drops anonymized (rare) queries, so a small site can have clicks but no queries.",
								],
							},
						}
					: undefined),
				blocks: [
					doc.fields(totalsFields(totals)),
					...(queries.length === 0
						? []
						: [
								doc.table(
									["Query", "Clicks", "Impressions", "CTR", "Position"],
									Arr.map(queries, (q) => [
										truncate(q.query, 80),
										formatNumber(q.clicks),
										formatNumber(q.impressions),
										formatPercent(q.ctr),
										q.position.toFixed(1),
									]),
								),
							]),
				],
				notices: [
					...(totals.impressions > 0
						? ["Deltas compare against the previous period of the same length."]
						: []),
					...(filtered
						? ["Totals are the whole property's; the filters narrow only the query list."]
						: []),
					...lagNotice(output),
					...(site.otherSites.length === 0
						? []
						: [`Other enabled properties (pass as site): ${Arr.join(site.otherSites, ", ")}.`]),
				],
				...(output.truncated
					? { truncation: { shown: queries.length, noun: "queries (raise limit)" } }
					: undefined),
				next,
			}
		},
	})
}
