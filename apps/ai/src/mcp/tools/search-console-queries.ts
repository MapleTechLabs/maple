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
	daysPastWatermark,
	resolveSearchConsoleSite,
	searchConsoleReadHandlers,
	searchConsoleReads,
	windowEndingAtWatermark,
} from "../lib/search-console"
import { doc, type NextCall } from "../lib/tool-doc"

const TOOL = "search_console_queries"
/** Google's 28-day default; it keeps 16 months, the comparison reads twice the window. */
const WINDOW = P.timeWindow({ defaultHours: 28 * 24, maxHours: 365 * 24 })
const MAX_LIMIT = 200

type Output = typeof SearchConsoleQueriesOutput.Type

const sqlString = (value: string): string =>
	`'${Str.replace(/'/g, "\\'")(Str.replace(/\\/g, "\\\\")(value))}'`

/** Daily clicks, impressions and position of one query: newest row version first, then summed. */
export const queryTrendSql = (siteUrl: string, query: string): string =>
	"SELECT Date, sum(c) AS clicks, sum(i) AS impressions, round(sum(p) / sum(i), 1) AS position FROM (" +
	"SELECT Date, Page, Country, Device, argMax(Clicks, IngestedAt) AS c, argMax(Impressions, IngestedAt) AS i, " +
	"argMax(PositionSum, IngestedAt) AS p FROM search_console_daily " +
	`WHERE $__orgFilter AND SiteUrl = ${sqlString(siteUrl)} AND Grain = 'query' AND Query = ${sqlString(query)} ` +
	"AND Date >= toStartOfDay($__startTime) AND Date <= $__endTime GROUP BY Date, Page, Country, Device" +
	") GROUP BY Date ORDER BY Date"

export const positionText = (current: number, previous: number): string =>
	current === 0
		? "-"
		: previous === 0
			? current.toFixed(1)
			: `${current.toFixed(1)} (was ${previous.toFixed(1)})`

export const lagNotice = (output: {
	readonly site: Output["site"]
	readonly timeRange: Output["timeRange"]
}): ReadonlyArray<string> => {
	const days = daysPastWatermark(output.timeRange.end, output.site.dataThrough)
	return days === 0
		? []
		: [
				`Data runs through ${output.site.dataThrough ?? "?"}; the last ${days} day${days === 1 ? "" : "s"} of this window are not imported yet (Google reports with a 2 to 3 day lag), so totals and deltas understate them. Omit end_time to end on the last imported day.`,
			]
}

export function registerSearchConsoleQueriesTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Search Console Queries",
		description:
			"Google search queries that bring people to the site, from the org's connected Google Search Console: clicks, impressions, CTR and average position per query, with the property's totals and their change against the previous period of the same length. Optional page, country and device filters. Google reports with a 2 to 3 day lag; with no window given it ends on the last imported day. Landing pages joined with Maple sessions, bounce rate and conversions: search_console_pages.",
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
				windowEndingAtWatermark(params, site.state.dataThrough),
				TOOL,
			)
			const sort = params.sort ?? "clicks"
			const country = params.country === undefined ? undefined : Str.toLowerCase(params.country)
			const window = { siteUrl: site.row.siteUrl, startTime: st, endTime: et }
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
					doc.fields([
						[
							"Clicks",
							`${formatNumber(totals.clicks)} (${formatDelta(totals.clicks, totals.previous.clicks)})`,
						],
						[
							"Impressions",
							`${formatNumber(totals.impressions)} (${formatDelta(totals.impressions, totals.previous.impressions)})`,
						],
						[
							"CTR",
							`${formatPercent(totals.ctr)} (${formatPointsDelta(totals.ctr, totals.previous.ctr)})`,
						],
						["Avg position", positionText(totals.position, totals.previous.position)],
					]),
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
					"Deltas compare against the previous period of the same length.",
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
