import { Clock, Effect, Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import {
	FUNNEL_MAX_EXCLUSIONS,
	FUNNEL_MAX_STEPS,
	FunnelBreakdownBy,
	FunnelExclusion,
	FunnelKeyBy,
	FunnelStep,
	funnelStepDetails,
	funnelStepLabel,
	type FunnelKeyBy as FunnelKeyByType,
} from "@maple/query-model"
import {
	productEventsFunnel,
	productEventsFunnelBreakdown,
	productEventsFunnelCoverage,
	productEventsFunnelLeavers,
	productEventsFunnelTiming,
} from "@maple/query-engine/observability"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor } from "../lib/query-warehouse"
import { CurrentMcpTenant } from "../tenant"
import { MCP_PRODUCT_EVENTS_MAX_HOURS } from "../lib/time"
import { formatDuration } from "@maple/domain/format"
import { formatNumber, formatPercent, truncate } from "../lib/format"
import { stringifyJson } from "../lib/json"
import * as P from "../lib/params"
import { PROPERTY_FILTER_FIELDS, propertyFilterArgs, propertyFiltersOf } from "../lib/attribute-filters"
import { doc } from "../lib/tool-doc"
import { orFallback } from "../lib/fallback"
import { identityNoteFor, isBlankStep, sessionRetentionNote } from "../lib/product-identity"
import { readHorizonDays } from "../lib/read-horizon"

const TOOL = "query_funnel"
const WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: MCP_PRODUCT_EVENTS_MAX_HOURS })

const decodeBreakdownBy = Schema.decodeUnknownOption(FunnelBreakdownBy)

const DEFAULT_WINDOW_SECONDS = 24 * 3600
const BREAKDOWN_MAX_GROUPS = 20

const STEPS_EXAMPLE =
	'[{"kind":"page","pagePath":"/pricing"},{"kind":"event","eventName":"signup_completed"},{"kind":"event","eventName":"plan_started","attributeEquals":{"plan":"pro"}}]'

const EXCLUSIONS_EXAMPLE = '[{"step":{"kind":"event","eventName":"support_opened"},"after":1,"before":2}]'

/** "support_opened between steps 1 and 3", for the scope line. */
const exclusionText = (exclusion: FunnelExclusion, stepCount: number): string =>
	`${funnelStepLabel(exclusion.step)} between steps ${exclusion.after ?? 1} and ${exclusion.before ?? stepCount}`

const KEY_BY_NOUN = {
	person: "persons",
	visitor: "visitors",
	user: "users",
	group: "groups",
	session: "sessions",
} satisfies Record<FunnelKeyByType, string>

/** Share of `denominator`, or null when there is nothing to divide by. */
const ratio = (numerator: number, denominator: number): number | null =>
	denominator > 0 ? numerator / denominator : null

const fmtPct = (fraction: number | null): string => (fraction === null ? "—" : formatPercent(fraction))

export function registerQueryFunnelTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Query Funnel",
		description:
			'Conversion funnel over product events (page views, browser `track()` events and server-side events), stitched per person, or per account with `key_by="group"`. Reports each step\'s count, share of step 1, step-to-step conversion and drop-off, optionally per `breakdown_by` group. An event step needs the exact name `list_product_events` lists; the path of a page step may use `*` for any run of characters (`/dashboards/*`). `details=true` adds time to convert and where the drop-offs went; `exclusions_json` counts only attempts in which something did not happen in between. The host, page, referrer, country, utm, device and browser filters narrow the population to persons with a matching session.',
		parameters: Schema.Struct({
			steps_json: P.json(
				Schema.Array(FunnelStep),
				`JSON array of 1-${FUNNEL_MAX_STEPS} steps, in order. A step is {kind:"event", eventName, attributeEquals?}, {kind:"page", pagePath, host?} (pagePath exact, or with * as a wildcard), or, as step 1 only, {kind:"session", dimension, value} for how the session was acquired (dimension: referrerHost, utmSource, utmMedium, utmCampaign, country or host). Example: ${STEPS_EXAMPLE}`,
			),
			exclusions_json: P.optionalJson(
				Schema.Array(FunnelExclusion),
				`JSON array of up to ${FUNNEL_MAX_EXCLUSIONS} things that must NOT happen part way through: {step, after?, before?}. \`step\` is {kind:"event", eventName, attributeEquals?} or {kind:"page", pagePath, host?}; an attempt that has reached step \`after\` (default 1) and not yet step \`before\` (default the last) is dropped when it happens. Example, converted without contacting support: [{"step":{"kind":"event","eventName":"support_opened"}}]`,
			),
			key_by: P.optionalOneOf(
				FunnelKeyBy.literals,
				"What to count: `person` (default: user id when known, else the visitor's linked user, else the visitor), `visitor`, `user`, `group` (the account or team the app identified the user into; the key for a step a backend sends for the account alone, such as a billing event), or `session` (per-session funnel; server events take no part).",
			),
			window_seconds: P.optionalNumber(
				"The whole chain must complete within this many seconds of the step-1 event. Default 86400 (24h).",
			),
			breakdown_by: P.optionalText(
				"Group by an acquisition dimension (referrerHost, utmSource, utmMedium, utmCampaign, country, host), by `attribute:<key>` on the events, or by the current value of a user property (`user:plan`) or account property (`group:tier`). Top groups by step-1 count.",
			),
			breakdown_limit: P.limit({ default: 10, max: BREAKDOWN_MAX_GROUPS, noun: "breakdown groups" }),
			details: P.optionalFlag(
				"Also report how long each step took (median and p90 since the previous step and since step 1) and what the people who dropped off did next. Needs two or more steps; left out with breakdown_by.",
			),
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
			...PROPERTY_FILTER_FIELDS,
		}),
		untrustedOutput: true,
		hints: { readOnly: true },
		permission: "telemetry:read",
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
				params.breakdown_by === undefined ||
				Arr.contains(["attribute:", "user:", "group:"], Str.trim(params.breakdown_by))
					? params.breakdown_by === undefined
						? undefined
						: Option.none()
					: decodeBreakdownBy(params.breakdown_by)
			if (breakdownOption !== undefined && Option.isNone(breakdownOption)) {
				return yield* new McpInvalidInputError({
					message: `breakdown_by must be one of referrerHost, utmSource, utmMedium, utmCampaign, country, host, attribute:<key>, user:<key> or group:<key>; got "${params.breakdown_by}".`,
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

			const givenFilters = Rec.filter(
				{
					host: params.host,
					page_path: params.page_path,
					referrer_host: params.referrer_host,
					country: params.country,
					utm_source: params.utm_source,
					utm_medium: params.utm_medium,
					utm_campaign: params.utm_campaign,
					device_type: params.device_type,
					browser: params.browser,
					...propertyFilterArgs(params),
				},
				(value): value is string => value !== undefined,
			)

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.steps": steps.length,
				"maple.ai.key_by": keyBy,
				"maple.ai.window_seconds": windowSeconds,
				"maple.ai.breakdown_by": breakdownBy ?? "none",
			})

			const exclusions = params.exclusions_json ?? []
			if (Arr.some(exclusions, (exclusion) => isBlankStep(exclusion.step))) {
				return yield* new McpInvalidInputError({
					message: "An exclusions_json entry has a step with no event name or page path.",
					parameter: "exclusions_json",
					example: EXCLUSIONS_EXAMPLE,
				})
			}
			const properties = yield* propertyFiltersOf(params)
			const definition = {
				steps,
				keyBy,
				windowSeconds,
				filters,
				...properties,
				...(exclusions.length > 0 ? { exclusions } : undefined),
				startTime: st,
				endTime: et,
			}

			// The builder's own validation is the last word (it also catches what the checks above did
			// not think of); its rejection is a caller error, not a tool failure.
			const outcome = yield* withTenantExecutor(productEventsFunnel(definition)).pipe(
				Effect.catchTags(warehouseToMcpHandlers(TOOL)),
				Effect.catchTag("@maple/query-engine/ProductEventsFunnelError", (error) =>
					Effect.fail(
						error.reason === "InvalidExclusion"
							? new McpInvalidInputError({
									message: error.message,
									parameter: "exclusions_json",
									example: EXCLUSIONS_EXAMPLE,
								})
							: new McpInvalidInputError({
									message: error.message,
									parameter: "steps_json",
									example: STEPS_EXAMPLE,
								}),
					),
				),
			)
			const counts = new Map(Arr.map(outcome, (row) => [row.step, row.count]))

			const first = counts.get(1) ?? 0
			const stepData = Arr.map(steps, (step, index) => {
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

			// A step can be empty because its events lack the identity counted by, which reads exactly
			// like nobody converting. Only then is the coverage worth a second read.
			const hasEventStep = Arr.some(steps, (step) => step.kind !== "session")
			const identity =
				hasEventStep && Arr.some(stepData, (stat) => stat.count === 0)
					? yield* withTenantExecutor(productEventsFunnelCoverage(definition)).pipe(
							Effect.map((coverage) =>
								identityNoteFor(
									coverage,
									keyBy,
									Arr.map(stepData, (stat) => `Step ${stat.step} (${stat.label})`),
									// An acquisition session has a visitor and no account, so a funnel that
									// starts at one cannot be offered the group key.
									Arr.some(steps, (step) => step.kind === "session")
										? Arr.filter(
												FunnelKeyBy.literals,
												(candidate) => candidate !== "group",
											)
										: FunnelKeyBy.literals,
								),
							),
							orFallback("funnel identity coverage", () => undefined),
						)
					: undefined

			// Time to convert and where the drop-offs went: two more reads, only when asked for.
			const wantsDetails =
				params.details === true &&
				steps.length >= 2 &&
				breakdownBy === undefined &&
				exclusions.length === 0 &&
				first > 0
			const details = wantsDetails
				? yield* Effect.all(
						{
							timing: withTenantExecutor(productEventsFunnelTiming(definition)),
							leavers: withTenantExecutor(productEventsFunnelLeavers(definition)),
						},
						{ concurrency: 2 },
					).pipe(
						Effect.map(({ timing, leavers }) => funnelStepDetails(timing, leavers)),
						orFallback("funnel step details", () => undefined),
					)
				: undefined
			const detailedSteps =
				details === undefined
					? stepData
					: Arr.map(stepData, (stat) => {
							const detail = details.get(stat.step)
							// Nobody reached it: the timing read's zeros are no measurement, only its leavers are.
							return stat.count > 0 || detail === undefined
								? { ...stat, ...detail }
								: {
										...stat,
										...(detail.leavers === undefined
											? undefined
											: { leavers: detail.leavers }),
									}
						})

			// Sessions are kept for the org's own period (30 days unless it set one), so anything
			// read off them is blind to the part before that.
			const readsSessions =
				Arr.some(steps, (step) => step.kind === "session") ||
				(breakdownBy !== undefined &&
					!Str.startsWith("attribute:")(breakdownBy) &&
					!Str.startsWith("user:")(breakdownBy) &&
					!Str.startsWith("group:")(breakdownBy) &&
					breakdownBy !== "host") ||
				Arr.some(Rec.values(filters), (value) => value !== undefined)
			const nowMs = yield* Clock.currentTimeMillis
			const sessionsKeptDays = yield* readHorizonDays("sessions")
			const sessionNote = sessionRetentionNote(
				{ startTime: st, endTime: et },
				nowMs,
				readsSessions,
				sessionsKeptDays,
			)
			// Asked for and not read: say so, or the missing section reads as "nothing to report".
			const detailsNote =
				wantsDetails && details === undefined
					? "The time between steps and the drop-offs' next steps could not be read this time; the counts are complete. Run it again, or narrow the window."
					: undefined

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
									const group = row.group
									const arr =
										byGroup.get(group) ??
										Array.from<number>({ length: steps.length }).fill(0)
									byGroup.set(group, arr)
									const index = row.step - 1
									if (index >= 0 && index < steps.length) arr[index] = row.count
								}
								const groups = Arr.map([...byGroup.entries()], ([group, groupCounts]) => ({
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
				steps: detailedSteps,
				conversion,
				...(breakdown === undefined ? undefined : { breakdown }),
				definition: steps,
				...(exclusions.length > 0 ? { exclusions } : undefined),
				...(Rec.isEmptyRecord(givenFilters) ? undefined : { filters: givenFilters }),
				...(identity === undefined ? undefined : { identityNote: identity.note }),
				...(identity?.keyBy === undefined ? undefined : { suggestedKeyBy: identity.keyBy }),
				...(sessionNote === undefined ? undefined : { sessionNote }),
				...(detailsNote === undefined ? undefined : { detailsNote }),
			}
		}),
		render: (output) => {
			const { steps, breakdown } = output
			const noun = KEY_BY_NOUN[output.keyBy]
			const first = steps[0]
			const last = steps[steps.length - 1]
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			// The funnel as asked, so a follow-up changes one thing and not the population.
			const sameFunnel = {
				steps_json: stringifyJson(output.definition),
				...(output.exclusions === undefined
					? undefined
					: { exclusions_json: stringifyJson(output.exclusions) }),
				...(output.windowSeconds === DEFAULT_WINDOW_SECONDS
					? undefined
					: { window_seconds: output.windowSeconds }),
				...output.filters,
				...window,
			}
			return {
				title: `Funnel (${steps.length} step${steps.length === 1 ? "" : "s"}, by ${output.keyBy}, within ${output.windowSeconds}s)`,
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					[
						"Without",
						output.exclusions === undefined
							? undefined
							: Arr.join(
									Arr.map(output.exclusions, (exclusion) =>
										exclusionText(exclusion, steps.length),
									),
									"; ",
								),
					],
				],
				...(output.identityNote === undefined &&
				output.sessionNote === undefined &&
				output.detailsNote === undefined
					? undefined
					: {
							notices: [
								...(output.identityNote === undefined ? [] : [output.identityNote]),
								...(output.sessionNote === undefined ? [] : [output.sessionNote]),
								...(output.detailsNote === undefined ? [] : [output.detailsNote]),
							],
						}),
				...(first === undefined || first.count === 0
					? {
							empty: {
								message: `Nobody matched step 1${first === undefined ? "" : ` (${first.label})`} in this window.`,
								// The notice above already says why; repeating it here would say it twice.
								hints:
									output.identityNote === undefined
										? [
												"Widen start_time/end_time, or check the step against `list_product_events`.",
											]
										: [],
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
										Str.toUpperCase(noun.charAt(0)) + Str.slice(1)(noun),
										"Of first",
										"Of previous",
										"Drop-off",
									],
									Arr.map(steps, (stat) => [
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
								...(output.exclusions === undefined
									? []
									: [
											doc.text(
												"An excluded event drops the attempt it interrupts, not the person: someone who starts over afterwards can still convert. Time to convert and the drop-offs' next steps are not reported with exclusions.",
											),
										]),
								...(Arr.some(steps, (stat) => stat.p50Ms !== undefined)
									? [
											doc.heading("Time to convert"),
											doc.table(
												[
													"#",
													"Step",
													"Median since previous",
													"p90 since previous",
													"Median since step 1",
												],
												Arr.map(
													Arr.filter(
														steps,
														(stat) => stat.step > 1 && stat.count > 0,
													),
													(stat) => [
														String(stat.step),
														truncate(stat.label, 60),
														formatDuration(stat.p50Ms ?? 0),
														formatDuration(stat.p90Ms ?? 0),
														formatDuration(stat.sinceStartP50Ms ?? 0),
													],
												),
											),
											doc.heading("Where the drop-offs went"),
											doc.list(
												Arr.map(
													Arr.filter(steps, (stat) => stat.step > 1),
													(stat) =>
														`Before step ${stat.step} (${truncate(stat.label, 40)}): ${
															stat.leavers === undefined ||
															stat.leavers.length === 0
																? "nobody dropped off"
																: Arr.join(
																		Arr.map(
																			stat.leavers,
																			(leaver) =>
																				`${leaver.name === "" ? "nothing after" : truncate(leaver.name, 40)} (${formatNumber(leaver.count)})`,
																		),
																		", ",
																	)
														}`,
												),
											),
										]
									: []),
								...(breakdown === undefined
									? []
									: [
											doc.heading(
												`By ${breakdown.by} (top ${breakdown.groups.length} by step 1)`,
											),
											doc.table(
												[
													breakdown.by,
													...Arr.map(steps, (stat) => `Step ${stat.step}`),
													"Conv.",
												],
												Arr.map(breakdown.groups, (group) => [
													group.group === "" ? "(none)" : truncate(group.group, 40),
													...Arr.map(group.counts, (count) => formatNumber(count)),
													fmtPct(group.conversion),
												]),
											),
										]),
								doc.text(
									output.exclusions === undefined
										? "Pin this funnel to a board with `add_dashboard_widget` (panel_type funnel, the steps under `display_json.funnel.steps`)."
										: "A dashboard funnel widget does not take exclusions yet: pinned, this funnel would count the attempts excluded here.",
								),
							],
				next: [
					// The funnel under the key its events carry is the answer the caller was after.
					...(output.suggestedKeyBy === undefined
						? []
						: [
								doc.next(
									TOOL,
									{
										...sameFunnel,
										key_by: output.suggestedKeyBy,
										...(breakdown === undefined
											? undefined
											: { breakdown_by: breakdown.by }),
									},
									`the same funnel counted by ${output.suggestedKeyBy}`,
								),
							]),
					doc.next(
						"list_product_events",
						window,
						"see which event names exist before adding a step",
					),
					breakdown === undefined
						? doc.next(
								TOOL,
								{
									...sameFunnel,
									...(output.keyBy === "person" ? undefined : { key_by: output.keyBy }),
									breakdown_by: "utmSource",
								},
								"see where the converters came from",
							)
						: doc.next("search_sessions", window, "read the sessions behind a group"),
				],
			}
		},
	})
}
