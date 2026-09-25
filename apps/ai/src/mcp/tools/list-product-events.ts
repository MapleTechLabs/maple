import { Effect, Schema } from "effect"
import { ListProductEventsOutput, ProductEventKind } from "@maple/domain/mcp-outputs"
import { productEventNames } from "@maple/query-engine/observability"
import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatNumber, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "list_product_events"
const WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: MCP_DISCOVERY_MAX_HOURS })

/** The query's own cap: a kind or name filter applies after it, so a narrowed read fetches all of it. */
const QUERY_MAX = 200

const TRACK_HINT =
	'To record product events call `maple.track("signup_completed", { plan: "pro" })` from the browser SDK, or `MapleEvents.track()` server-side; each name then shows up here and can be a funnel step.'

export function registerListProductEventsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		description:
			"List the product event names an org recorded (browser `track()` events, server-side events, page views) with how often each fired and how many sessions and persons it reached. Use it to find exact step names for `query_funnel`. `kind`: `custom` is a `track()` or server event, `navigation` a page view, `screen` a mobile screen. `kind` and `search` select among the 200 most frequent names in the window.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			kind: P.optionalOneOf(
				ProductEventKind.literals,
				"Only events of this kind (see the description for what each means). Default: all.",
			),
			search: P.optionalText("Case-insensitive substring match on the event name."),
			host: P.optionalText("Only events from sessions on this site host."),
			page_path: P.optionalText("Only events from sessions that viewed this page path."),
			referrer_host: P.optionalText("Only events from sessions referred by this host."),
			country: P.optionalText("Only events from sessions in this country (ISO code)."),
			utm_source: P.optionalText("Only events from sessions carrying this utm_source."),
			utm_medium: P.optionalText("Only events from sessions carrying this utm_medium."),
			utm_campaign: P.optionalText("Only events from sessions carrying this utm_campaign."),
			limit: P.limit({ default: 50, max: QUERY_MAX, noun: "event names" }),
		}),
		output: ListProductEventsOutput,
		hints: { readOnly: true },
		phrases: ["Listing product events"],
		handler: Effect.fn("McpTool.listProductEvents")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const limit = params.limit

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, kind: params.kind ?? "any", limit })

			// The query ranks every name; kind and name filters apply here so the limit still means
			// "names shown". Fetch the full cap when narrowing.
			const narrowed = params.kind !== undefined || params.search !== undefined
			const rows = yield* withTenantExecutor(
				productEventNames({
					startTime: st,
					endTime: et,
					limit: narrowed ? QUERY_MAX : limit,
					filters: {
						host: params.host,
						pagePath: params.page_path,
						referrerHost: params.referrer_host,
						country: params.country,
						utmSource: params.utm_source,
						utmMedium: params.utm_medium,
						utmCampaign: params.utm_campaign,
					},
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))

			const search = params.search?.toLowerCase()
			const events = rows
				.filter((row) => params.kind === undefined || row.kind === params.kind)
				.filter((row) => search === undefined || row.eventName.toLowerCase().includes(search))
				.slice(0, limit)
				.map((row) => ({
					eventName: row.eventName,
					kind: row.kind,
					count: Number(row.count) || 0,
					sessions: Number(row.sessions) || 0,
					persons: Number(row.persons) || 0,
				}))
			yield* Effect.annotateCurrentSpan("result.rowCount", events.length)

			return {
				timeRange: { start: st, end: et },
				events,
				...(params.kind === undefined ? undefined : { kind: params.kind }),
				narrowed,
			}
		}),
		render: (output) => {
			const { events } = output
			const customEvents = events.filter((event) => event.kind === "custom")
			const suggested = customEvents
				.slice(0, 2)
				.map((event) => ({ kind: "event", eventName: event.eventName }))
			const expectsCustom = output.kind === undefined || output.kind === "custom"
			return {
				title: output.narrowed ? "Product events (matching)" : "Product events",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Kind", output.kind],
				],
				...(events.length === 0
					? {
							empty: {
								message: output.narrowed
									? `No product events matched among the ${QUERY_MAX} most frequent names in the window.`
									: "No product events matched.",
								hints: expectsCustom
									? [TRACK_HINT]
									: ["Widen start_time/end_time, or drop the filters."],
							},
						}
					: undefined),
				blocks:
					events.length === 0
						? []
						: [
								doc.table(
									["Event", "Kind", "Count", "Sessions", "Persons"],
									events.map((event) => [
										truncate(event.eventName, 60),
										event.kind,
										formatNumber(event.count),
										formatNumber(event.sessions),
										formatNumber(event.persons),
									]),
								),
								...(customEvents.length === 0
									? [
											doc.text(
												"Only page views so far, no `track()` events. Page steps still work in `query_funnel`; custom events come from `maple.track(name, props)` in the browser SDK or `MapleEvents.track()` server-side.",
											),
										]
									: []),
							],
				next:
					events.length === 0
						? []
						: [
								suggested.length > 0
									? doc.next(
											"query_funnel",
											{ steps_json: JSON.stringify(suggested) },
											"measure conversion between them",
										)
									: doc.next(
											"query_funnel",
											{
												steps_json: JSON.stringify([
													{ kind: "page", pagePath: "/" },
													{ kind: "page", pagePath: "/pricing" },
												]),
											},
											"a page-to-page funnel",
										),
							],
			}
		},
	})
}
