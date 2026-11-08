import { Effect, Order, Schema, Array as Arr } from "effect"
import { SearchConsoleLandingPagesRequest } from "@maple/domain/http"
import { SearchConsolePagesOutput, SearchConsoleToolSort } from "@maple/domain/mcp-outputs"
import type { McpToolRegistrar } from "./types"
import { formatNumber, formatPercent, truncate } from "../lib/format"
import * as P from "../lib/params"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import {
	resolveSearchConsoleSite,
	searchConsoleReadHandlers,
	searchConsoleReads,
	windowEndingAtWatermark,
} from "../lib/search-console"
import { doc, type NextCall } from "../lib/tool-doc"
import { lagNotice } from "./search-console-queries"

const TOOL = "search_console_pages"
/** The join also scans web analytics sessions over the window, so it stays shorter than queries'. */
const WINDOW = P.timeWindow({ defaultHours: 28 * 24, maxHours: 90 * 24 })
const MAX_LIMIT = 200

type Row = (typeof SearchConsolePagesOutput.Type)["pages"][number]
type Sort = typeof SearchConsoleToolSort.Type

/** Descending, except position, where lower is better. Clicks break ties. */
const orderFor = (sort: Sort): Order.Order<Row> =>
	Order.combine(
		sort === "position"
			? Order.mapInput(Order.Number, (row: Row) => row.position)
			: Order.mapInput(Order.flip(Order.Number), (row: Row) => row[sort]),
		Order.mapInput(Order.flip(Order.Number), (row: Row) => row.clicks),
	)

export function registerSearchConsolePagesTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Search Console Pages",
		description:
			"Landing pages from Google search, from the org's connected Google Search Console (clicks, impressions, CTR, average position), joined by host and path with Maple's own web analytics for the same window: human sessions that entered on the page, bounce rate and, with `conversion_event`, sessions that fired that event. Spots pages with many impressions but low CTR (sort=impressions), or many search clicks that bounce. Google reports with a 2 to 3 day lag; with no window given it ends on the last imported day. The queries behind a page: search_console_queries with `page`.",
		parameters: Schema.Struct({
			site: P.optionalText(
				"Search Console property, e.g. `sc-domain:example.com` or `https://example.com/` (a bare host matches too). Default: the org's first enabled property with data",
			),
			...WINDOW.fields,
			sort: P.optionalOneOf(
				SearchConsoleToolSort.literals,
				"Which search pages to take and their order (default clicks); position sorts best (lowest) first",
			),
			conversion_event: P.optionalText(
				"A `track()` event name; sessions entering on the page that fired it count as conversions",
			),
			limit: P.limit({ default: 25, max: MAX_LIMIT, noun: "pages" }),
		}),
		output: SearchConsolePagesOutput,
		hints: { readOnly: true },
		phrases: ["Reading Search Console pages", "Joining search pages with sessions"],
		handler: Effect.fn("McpTool.searchConsolePages")(function* (params) {
			const site = yield* resolveSearchConsoleSite(TOOL, params.site)
			const { st, et } = yield* WINDOW.resolve(
				windowEndingAtWatermark(params, site.state.dataThrough),
				TOOL,
			)
			const sort = params.sort ?? "clicks"
			const tenant = yield* CurrentMcpTenant
			const reads = yield* searchConsoleReads
			const merged = yield* reads
				.landingPages(
					tenant,
					new SearchConsoleLandingPagesRequest({
						siteUrl: site.row.siteUrl,
						startTime: st,
						endTime: et,
						sortBy: sort,
						// One extra row says whether more exist.
						limit: params.limit + 1,
						...(params.conversion_event === undefined
							? undefined
							: { conversionEvent: params.conversion_event }),
					}),
				)
				.pipe(Effect.catchTags(searchConsoleReadHandlers(TOOL)))
			yield* Effect.annotateCurrentSpan("result.rowCount", merged.length)
			const pages = Arr.sort(merged, orderFor(sort))
			return {
				site: site.state,
				timeRange: { start: st, end: et },
				sort,
				...(params.conversion_event === undefined
					? undefined
					: { conversionEvent: params.conversion_event }),
				pages: pages.slice(0, params.limit),
				truncated: pages.length > params.limit,
			}
		}),
		render: (output) => {
			const { pages, site } = output
			const withConversions = output.conversionEvent !== undefined
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			const top = pages[0]
			const noSessions = pages.length > 0 && Arr.every(pages, (row) => row.sessions === 0)
			const next: Array<NextCall> =
				top === undefined
					? [
							doc.next(
								"search_console_queries",
								{ site: site.siteUrl, ...window },
								"the search queries",
							),
						]
					: [
							doc.next(
								"search_console_queries",
								{ site: site.siteUrl, page: top.page, ...window },
								`the queries landing on ${truncate(top.path, 40)}`,
							),
							doc.next(
								"run_sql",
								{
									sql: "SELECT Grain, count() AS rows, min(Date) AS first_day, max(Date) AS last_day FROM search_console_daily WHERE $__orgFilter AND Date >= toStartOfDay($__startTime) AND Date <= $__endTime GROUP BY Grain",
									...window,
								},
								"what search_console_daily holds for custom SQL",
							),
						]
			return {
				title: `Search Console pages: ${site.siteUrl}`,
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Data through", site.dataThrough ?? undefined],
					["Sort", output.sort],
					["Conversion event", output.conversionEvent],
				],
				...(site.lastError === null
					? undefined
					: { warnings: [`Last import failed: ${site.lastError}`] }),
				...(pages.length === 0
					? { empty: { message: "No search landing pages in this window." } }
					: undefined),
				blocks:
					pages.length === 0
						? []
						: [
								doc.table(
									[
										"Path",
										"Host",
										"Clicks",
										"Impressions",
										"CTR",
										"Position",
										"Sessions",
										"Bounce",
										...(withConversions ? ["Conversions"] : []),
									],
									Arr.map(pages, (row) => [
										truncate(row.path, 70),
										row.host,
										formatNumber(row.clicks),
										formatNumber(row.impressions),
										formatPercent(row.ctr),
										row.position.toFixed(1),
										formatNumber(row.sessions),
										row.bounceRate === null ? "-" : formatPercent(row.bounceRate),
										...(withConversions ? [formatNumber(row.conversions ?? 0)] : []),
									]),
								),
							],
				notices: [
					"Sessions, bounce and conversions are Maple browser sessions (humans only) that entered on the page from any source, not only search.",
					...(noSessions
						? [
								"No Maple sessions entered on these pages: the site may not run Maple's browser SDK, or it records another host.",
							]
						: []),
					...lagNotice(output),
					...(site.otherSites.length === 0
						? []
						: [`Other enabled properties (pass as site): ${Arr.join(site.otherSites, ", ")}.`]),
				],
				...(output.truncated
					? { truncation: { shown: pages.length, noun: "pages (raise limit)" } }
					: undefined),
				next,
			}
		},
	})
}
