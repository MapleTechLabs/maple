import { Effect, Option, Schema } from "effect"
import {
	FUNNEL_MAX_STEPS,
	FunnelBreakdownBy,
	FunnelKeyBy,
	FunnelStep,
	funnelStepLabel,
	type FunnelKeyBy as FunnelKeyByType,
} from "@maple/query-model"
import { QueryFunnelOutput } from "@maple/domain/mcp-outputs"
import { productEventsFunnel, productEventsFunnelBreakdown } from "@maple/query-engine/observability"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatNumber, formatPercent, truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "query_funnel"
const WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: MCP_DISCOVERY_MAX_HOURS })

const decodeBreakdownBy = Schema.decodeUnknownOption(FunnelBreakdownBy)

const DEFAULT_WINDOW_SECONDS = 24 * 3600
const BREAKDOWN_MAX_GROUPS = 20

const STEPS_EXAMPLE =
	'[{"kind":"page","pagePath":"/pricing"},{"kind":"event","eventName":"signup_completed"},{"kind":"event","eventName":"plan_started","attributeEquals":{"plan":"pro"}}]'

const KEY_BY_NOUN = {
	person: "persons",
	visitor: "visitors",
	user: "users",
	session: "sessions",
} satisfies Record<FunnelKeyByType, string>

/** Share of `denominator`, or null when there is nothing to divide by. */
const ratio = (numerator: number, denominator: number): number | null =>
	denominator > 0 ? numerator / denominator : null

const fmtPct = (fraction: number | null): string => (fraction === null ? "—" : formatPercent(fraction))

export function registerQueryFunnelTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		description:
			'Run a conversion funnel over product events: page views, browser `track()` events and server-side events, stitched per person. Give 1-10 ordered steps as `steps_json`; each step is `{kind:"event", eventName, attributeEquals?}`, `{kind:"page", pagePath, host?}`, or (step 1 only) `{kind:"session", dimension, value}` for how the session was acquired (`dimension`: referrerHost | utmSource | utmMedium | utmCampaign | country | host). Returns per-step counts, share of step 1, step-to-step conversion and drop-off; optionally broken down by an acquisition dimension or an event attribute (`breakdown_by`: one of the session dimensions, or `attribute:<key>`). Call `list_product_events` first to see which event names exist. Filters (`host`, `page_path`, `referrer_host`, `country`, `utm_*`, `device_type`, `browser`) narrow the population to persons with a matching session.',
		parameters: Schema.Struct({
			steps_json: P.json(
				Schema.Array(FunnelStep),
				`JSON array of 1-${FUNNEL_MAX_STEPS} funnel steps, in order. Example: ${STEPS_EXAMPLE}`,
			),
			key_by: P.optionalOneOf(
				FunnelKeyBy.literals,
				"What to count: `person` (default: user id when known, else the visitor's linked user, else the visitor), `visitor`, `user`, or `session` (per-session funnel; server events take no part).",
			),
			window_seconds: P.optionalNumber(
				"The whole chain must complete within this many seconds of the step-1 event. Default 86400 (24h).",
			),
			breakdown_by: P.optionalText(
				"Group persons by `referrerHost`, `utmSource`, `utmMedium`, `utmCampaign`, `country`, `host`, or `attribute:<key>` (an attribute on their events). Top groups by step-1 count.",
			),
			breakdown_limit: P.limit({ default: 10, max: BREAKDOWN_MAX_GROUPS, noun: "breakdown groups" }),
			...WINDOW.fields,
			host: P.optionalText("Only persons with a session on this site host."),
			page_path: P.optionalText("Only persons with a session that viewed this page path."),
			referrer_host: P.optionalText("Only persons whose session was referred by this host."),
			country: P.optionalText("Only persons with a session from this country (ISO code)."),
			utm_source: P.optionalText("Only persons with a session carrying this utm_source."),
			utm_medium: P.optionalText("Only persons with a session carrying this utm_medium."),
			utm_campaign: P.optionalText("Only persons with a session carrying this utm_campaign."),
			device_type: P.optionalText(
				"Only persons with a session on this device type (desktop, mobile, tablet).",
			),
			browser: P.optionalText("Only persons with a session in this browser (e.g. Chrome)."),
		}),
		output: QueryFunnelOutput,
		hints: { readOnly: true },
		phrases: ["Computing a funnel", "Querying a funnel"],
		handler: Effect.fn("McpTool.queryFunnel")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)

			const steps = params.steps_json
			if (steps.length === 0) {
				return yield* new McpInvalidInputError({
					message: "steps_json must contain at least one step.",
					parameter: "steps_json",
					example: STEPS_EXAMPLE,
				})
			}
			if (steps.length > FUNNEL_MAX_STEPS) {
				return yield* new McpInvalidInputError({
					message: `A funnel has at most ${FUNNEL_MAX_STEPS} steps, got ${steps.length}.`,
					parameter: "steps_json",
				})
			}
			const lateSession = steps.findIndex((step, index) => index > 0 && step.kind === "session")
			if (lateSession !== -1) {
				return yield* new McpInvalidInputError({
					message: `A session step is only valid as step 1, found one at step ${lateSession + 1}.`,
					parameter: "steps_json",
					example:
						'[{"kind":"session","dimension":"utmSource","value":"twitter"},{"kind":"event","eventName":"signup_completed"}]',
				})
			}

			const keyBy = params.key_by ?? "person"
			const windowSeconds = params.window_seconds ?? DEFAULT_WINDOW_SECONDS
			if (windowSeconds <= 0) {
				return yield* new McpInvalidInputError({
					message: `window_seconds must be a positive number; got ${windowSeconds}.`,
					parameter: "window_seconds",
				})
			}

			// `attribute:<key>` is open-ended, so this is checked here rather than published as an enum.
			const breakdownOption =
				params.breakdown_by === undefined ? undefined : decodeBreakdownBy(params.breakdown_by)
			if (breakdownOption !== undefined && Option.isNone(breakdownOption)) {
				return yield* new McpInvalidInputError({
					message: `breakdown_by must be one of referrerHost, utmSource, utmMedium, utmCampaign, country, host, or attribute:<key>; got "${params.breakdown_by}".`,
					parameter: "breakdown_by",
					example: '{ "breakdown_by": "attribute:plan" }',
				})
			}
			const breakdownBy = breakdownOption?.value

			const filters = {
				host: params.host,
				pagePath: params.page_path,
				referrerHost: params.referrer_host,
				country: params.country,
				utmSource: params.utm_source,
				utmMedium: params.utm_medium,
				utmCampaign: params.utm_campaign,
				deviceType: params.device_type,
				browserName: params.browser,
			}

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				steps: steps.length,
				keyBy,
				windowSeconds,
				breakdownBy: breakdownBy ?? "none",
			})

			const definition = { steps, keyBy, windowSeconds, filters, startTime: st, endTime: et }

			// The builder's own validation is the last word (it also catches what the checks above did
			// not think of); its rejection is a caller error, not a tool failure.
			const outcome = yield* withTenantExecutor(productEventsFunnel(definition)).pipe(
				Effect.catchTags(warehouseToMcpHandlers(TOOL)),
				Effect.catchTag("@maple/query-engine/ProductEventsFunnelError", (error) =>
					Effect.fail(
						new McpInvalidInputError({
							message: error.message,
							parameter: "steps_json",
							example: STEPS_EXAMPLE,
						}),
					),
				),
			)
			const counts = new Map(outcome.map((row) => [Number(row.step), Number(row.count) || 0]))

			const first = counts.get(1) ?? 0
			const stepData = steps.map((step, index) => {
				const count = counts.get(index + 1) ?? 0
				const previous = index === 0 ? null : (counts.get(index) ?? 0)
				return {
					step: index + 1,
					label: funnelStepLabel(step),
					count,
					ofFirst: index === 0 ? (first > 0 ? 1 : 0) : (ratio(count, first) ?? 0),
					ofPrevious: previous === null ? null : ratio(count, previous),
					dropOff: previous === null ? 0 : Math.max(0, previous - count),
				}
			})
			const last = stepData[stepData.length - 1]
			const conversion = steps.length < 2 || last === undefined ? null : ratio(last.count, first)

			const breakdown =
				breakdownBy === undefined || first === 0
					? undefined
					: yield* withTenantExecutor(
							productEventsFunnelBreakdown({
								...definition,
								breakdownBy,
								limit: params.breakdown_limit,
							}),
						).pipe(
							Effect.catchTags(warehouseToMcpHandlers(TOOL)),
							// The definition already ran once above, so a builder rejection here cannot
							// happen; keep the channel typed rather than dying on it.
							Effect.catchTag("@maple/query-engine/ProductEventsFunnelError", () =>
								Effect.succeed([]),
							),
							Effect.map((groupRows) => {
								const byGroup = new Map<string, number[]>()
								for (const row of groupRows) {
									const group = String(row.group)
									const arr =
										byGroup.get(group) ??
										Array.from<number>({ length: steps.length }).fill(0)
									byGroup.set(group, arr)
									const index = Number(row.step) - 1
									if (index >= 0 && index < steps.length)
										arr[index] = Number(row.count) || 0
								}
								const groups = [...byGroup.entries()].map(([group, groupCounts]) => ({
									group,
									counts: groupCounts,
									conversion:
										steps.length < 2
											? null
											: ratio(
													groupCounts[groupCounts.length - 1] ?? 0,
													groupCounts[0] ?? 0,
												),
								}))
								return { by: breakdownBy, groups }
							}),
						)

			return {
				timeRange: { start: st, end: et },
				keyBy,
				windowSeconds,
				steps: stepData,
				conversion,
				...(breakdown === undefined ? undefined : { breakdown }),
				definition: steps,
			}
		}),
		render: (output) => {
			const { steps, breakdown } = output
			const noun = KEY_BY_NOUN[output.keyBy]
			const first = steps[0]
			const last = steps[steps.length - 1]
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			const stepsJson = JSON.stringify(output.definition)
			return {
				title: `Funnel (${steps.length} step${steps.length === 1 ? "" : "s"}, by ${output.keyBy}, within ${output.windowSeconds}s)`,
				scope: [["Time range", `${output.timeRange.start} to ${output.timeRange.end}`]],
				...(first === undefined || first.count === 0
					? {
							empty: {
								message: `Nobody matched step 1${first === undefined ? "" : ` (${first.label})`} in this window.`,
								hints: [
									"Widen start_time/end_time, or check the step against `list_product_events`.",
								],
							},
						}
					: undefined),
				blocks:
					first === undefined || first.count === 0
						? []
						: [
								doc.table(
									[
										"#",
										"Step",
										noun.charAt(0).toUpperCase() + noun.slice(1),
										"Of first",
										"Of previous",
										"Drop-off",
									],
									steps.map((stat) => [
										String(stat.step),
										truncate(stat.label, 60),
										formatNumber(stat.count),
										fmtPct(stat.ofFirst),
										fmtPct(stat.ofPrevious),
										stat.step === 1 ? "—" : `-${formatNumber(stat.dropOff)}`,
									]),
								),
								doc.text(
									output.conversion === null || last === undefined
										? "Add a second step to measure conversion."
										: `**Conversion: ${formatPercent(output.conversion)}** (${formatNumber(last.count)} of ${formatNumber(first.count)} ${noun}).`,
								),
								...(breakdown === undefined
									? []
									: [
											doc.heading(
												`By ${breakdown.by} (top ${breakdown.groups.length} by step 1)`,
											),
											doc.table(
												[
													breakdown.by,
													...steps.map((stat) => `Step ${stat.step}`),
													"Conv.",
												],
												breakdown.groups.map((group) => [
													group.group === "" ? "(none)" : truncate(group.group, 40),
													...group.counts.map((count) => formatNumber(count)),
													fmtPct(group.conversion),
												]),
											),
										]),
								doc.text(
									"Pin this funnel to a board with `add_dashboard_widget` (panel_type funnel, the steps under `display_json.funnel.steps`).",
								),
							],
				next: [
					doc.next(
						"list_product_events",
						window,
						"see which event names exist before adding a step",
					),
					breakdown === undefined
						? doc.next(
								TOOL,
								{ steps_json: stepsJson, breakdown_by: "utmSource", ...window },
								"see where the converters came from",
							)
						: doc.next("search_sessions", window, "read the sessions behind a group"),
				],
			}
		},
	})
}
