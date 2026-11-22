import { Clock, Effect, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import {
	funnelStepLabel,
	PathsAnchor,
	RETENTION_MAX_PERIODS,
	RetentionInterval,
	RetentionKeyBy,
	type PathsAnchor as PathsAnchorType,
	type RetentionInterval as RetentionIntervalType,
	type RetentionKeyBy as RetentionKeyByType,
} from "@maple/query-model"
import { parseWarehouseDateTime, warehouseDateTime } from "@maple/query-engine"
import { productEventsRetention } from "@maple/query-engine/observability"
import { QueryRetentionOutput } from "@maple/domain/mcp-outputs"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor } from "../lib/query-warehouse"
import { CurrentMcpTenant } from "../tenant"
import { formatNumber, formatPercent } from "../lib/format"
import { stringifyJson } from "../lib/json"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { eventIdentityNote, isBlankStep } from "../lib/product-identity"

const TOOL = "query_retention"
const DAY_MS = 86_400_000
/** Cohorts over eight weeks by default; half a year at most, which the table keeps twice over. */
const WINDOW = P.timeWindow({ defaultHours: 56 * 24, maxHours: 190 * 24 })

const DEFAULT_PERIODS = {
	day: 14,
	week: 8,
	month: 6,
} satisfies Record<RetentionIntervalType, number>

const KEY_BY_NOUN = {
	person: "persons",
	visitor: "visitors",
	user: "users",
	group: "groups",
} satisfies Record<RetentionKeyByType, string>

const STEP_EXAMPLE = '{"kind":"event","eventName":"signup_completed"}'

type Output = typeof QueryRetentionOutput.Type

/** The UTC start of the interval `n` after the one starting at `startMs`. */
const intervalAfter = (interval: RetentionIntervalType, startMs: number, n: number): number => {
	switch (interval) {
		case "day":
			return startMs + n * DAY_MS
		case "week":
			return startMs + n * 7 * DAY_MS
		case "month": {
			const start = new Date(startMs)
			return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n, 1)
		}
	}
}

/** The UTC start of the interval `ms` falls in. */
const intervalStart = (interval: RetentionIntervalType, ms: number): number => {
	const day = Math.floor(ms / DAY_MS)
	switch (interval) {
		case "day":
			return day * DAY_MS
		case "week":
			// 1970-01-01 was a Thursday: index 3 of a Monday-first week.
			return (day - ((day + 3) % 7)) * DAY_MS
		case "month": {
			const date = new Date(ms)
			return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
		}
	}
}

/** The longest an interval lasts, for how far past the window returns can still land. */
const MAX_INTERVAL_MS = { day: DAY_MS, week: 7 * DAY_MS, month: 31 * DAY_MS } satisfies Record<
	RetentionIntervalType,
	number
>

/** `YYYY-MM-DD` as the UTC millisecond its day starts at. */
const dayStartMs = (day: string): number => {
	const [year, month, date] = Arr.map(Str.split("-")(day), Number)
	return Date.UTC(year, (month ?? 1) - 1, date ?? 1)
}

const stepLabel = (step: PathsAnchorType | undefined): string =>
	step === undefined ? "any event" : funnelStepLabel(step)

/**
 * Cohort rows as the table a reader wants: one row per cohort with its size, its returns per
 * period, and how many of those periods have happened yet. `throughMs` is where returns were read
 * up to; a period that had not started by then is not a 0.
 */
export const retentionTable = (
	rows: ReadonlyArray<{ readonly cohort: string; readonly period: number; readonly count: number }>,
	interval: RetentionIntervalType,
	periods: number,
	throughMs: number,
): Pick<Output, "cohorts" | "overall"> => {
	const byCohort = Arr.groupBy(rows, (row) => row.cohort)
	const cohorts = Arr.map(Arr.sort(Rec.keys(byCohort), Str.Order), (cohort) => {
		const counts = new Map(Arr.map(byCohort[cohort] ?? [], (row) => [row.period, row.count]))
		const startMs = dayStartMs(cohort)
		const started = (n: number) => intervalAfter(interval, startMs, n) <= throughMs
		const complete = (n: number) => intervalAfter(interval, startMs, n + 1) <= throughMs
		const indices = Arr.makeBy(periods, (index) => index + 1)
		return {
			cohort,
			size: counts.get(0) ?? 0,
			returned: Arr.map(indices, (n) => counts.get(n) ?? 0),
			completePeriods: Arr.filter(indices, complete).length,
			startedPeriods: Arr.filter(indices, started).length,
		}
	})
	const overall = Arr.makeBy(periods, (index) => {
		const finished = Arr.filter(cohorts, (cohort) => cohort.completePeriods > index)
		const size = Arr.reduce(finished, 0, (sum, cohort) => sum + cohort.size)
		const returned = Arr.reduce(finished, 0, (sum, cohort) => sum + (cohort.returned[index] ?? 0))
		return size === 0 ? null : returned / size
	})
	return { cohorts, overall }
}

export function registerQueryRetentionTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Query Retention",
		description:
			'Retention cohorts over product events: of the people (or accounts, with `key_by="group"`) who first did the start event in each day, week or month, how many did the return event in each interval after it. ' +
			"By default a cohort is who did the start event for the first time EVER, read over all stored history, so people already active before the window are in no cohort; `first_ever=false` reads firsts from the window alone. " +
			"With no start or return step it is plain user retention: first seen, then any activity. Names for an event step come from `list_product_events`.",
		parameters: Schema.Struct({
			start_json: P.optionalJson(
				PathsAnchor,
				`What puts someone in a cohort, as JSON: {kind:"event", eventName, attributeEquals?} or {kind:"page", pagePath, host?}. Their FIRST such event sets the cohort. Default: any event (first seen). Example: ${STEP_EXAMPLE}`,
			),
			return_json: P.optionalJson(
				PathsAnchor,
				"What counts as coming back, in the same form. Default: any event.",
			),
			key_by: P.optionalOneOf(
				RetentionKeyBy.literals,
				"Who is counted: `person` (default: user id when known, else the visitor's linked user, else the visitor), `user`, `visitor`, or `group` (the account or team).",
			),
			interval: P.optionalOneOf(
				RetentionInterval.literals,
				"Cohort and period size, in UTC: `day`, `week` (default, Monday to Sunday) or `month`.",
			),
			periods: P.optionalNumber(
				`Intervals after the cohort's own to report, 1 to ${RETENTION_MAX_PERIODS}. Default 14 days, 8 weeks or 6 months.`,
			),
			first_ever: P.optionalFlag(
				"Default true: a cohort is who did the start event for the first time ever. false: for the first time in the window, which counts everyone already active as new in its first interval.",
			),
			...WINDOW.fields,
		}),
		untrustedOutput: true,
		hints: { readOnly: true },
		phrases: ["Computing retention", "Building retention cohorts"],
		handler: Effect.fn("McpTool.queryRetention")(function* (params) {
			const requested = yield* WINDOW.resolve(params, TOOL)
			const interval = params.interval ?? "week"
			const keyBy = params.key_by ?? "person"
			const periods = params.periods ?? DEFAULT_PERIODS[interval]
			const firstEver = params.first_ever ?? true
			if (!Number.isInteger(periods) || periods < 1 || periods > RETENTION_MAX_PERIODS) {
				return yield* new McpInvalidInputError({
					message: `periods must be a whole number from 1 to ${RETENTION_MAX_PERIODS}; got ${periods}.`,
					parameter: "periods",
				})
			}

			const blank = Arr.findFirst(
				[
					["start_json", params.start_json],
					["return_json", params.return_json],
				] as const,
				([, step]) => step !== undefined && isBlankStep(step),
			)
			if (blank._tag === "Some") {
				return yield* new McpInvalidInputError({
					message: `${blank.value[0]} needs an event name or a page path; leave it out for any event.`,
					parameter: blank.value[0],
					example: STEP_EXAMPLE,
				})
			}

			// Whole intervals only: a window that starts mid-week would hold part of that week's
			// cohort and call it the week's. It is widened to the interval's edges, never past now.
			const now = yield* Clock.currentTimeMillis
			const startMs = intervalStart(interval, parseWarehouseDateTime(requested.st))
			const lastStart = intervalStart(interval, parseWarehouseDateTime(requested.et) - 1)
			const st = warehouseDateTime(startMs)
			const et = warehouseDateTime(Math.min(now, intervalAfter(interval, lastStart, 1)))
			// Returns are followed past the cohort window, up to now: the last cohorts are the
			// ones a reader looks at first, and they would otherwise always read as lost.
			const throughMs = Math.min(
				now,
				parseWarehouseDateTime(et) + (periods + 1) * MAX_INTERVAL_MS[interval],
			)
			const returnEndTime = warehouseDateTime(throughMs)

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.key_by": keyBy,
				"maple.ai.interval": interval,
				"maple.ai.periods": periods,
				"maple.ai.first_ever": firstEver,
			})

			const rows = yield* withTenantExecutor(
				productEventsRetention({
					...(params.start_json === undefined ? undefined : { startEvent: params.start_json }),
					...(params.return_json === undefined ? undefined : { returnEvent: params.return_json }),
					keyBy,
					interval,
					periods,
					firstEver,
					startTime: st,
					endTime: et,
					returnEndTime,
				}),
			).pipe(
				Effect.catchTags(warehouseToMcpHandlers(TOOL)),
				// The period count is checked above, so the builder has nothing left to reject.
				Effect.catchTag("@maple/query-engine/ProductEventsRetentionError", (error) =>
					Effect.fail(new McpInvalidInputError({ message: error.message, parameter: "periods" })),
				),
			)
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)

			// No cohort at all: nobody was new, or the start events cannot be counted by this key.
			const start = params.start_json
			const identity =
				rows.length === 0 && start !== undefined
					? yield* eventIdentityNote({
							// The return event too: a key it lacks would show cohorts nobody comes back to.
							events: [
								{ step: start, label: funnelStepLabel(start) },
								...(params.return_json === undefined
									? []
									: [
											{
												step: params.return_json,
												label: funnelStepLabel(params.return_json),
											},
										]),
							],
							keyBy,
							candidates: RetentionKeyBy.literals,
							startTime: st,
							endTime: et,
						})
					: undefined

			return {
				timeRange: { start: st, end: et },
				...(identity === undefined ? undefined : { identityNote: identity.note }),
				...(identity?.keyBy === undefined ? undefined : { suggestedKeyBy: identity.keyBy }),
				returnsThrough: returnEndTime,
				keyBy,
				interval,
				periods,
				firstEver,
				...(params.start_json === undefined ? undefined : { start: params.start_json }),
				...(params.return_json === undefined ? undefined : { return: params.return_json }),
				...retentionTable(rows, interval, periods, throughMs),
			}
		}),
		render: (output) => {
			const noun = KEY_BY_NOUN[output.keyBy]
			const unit = output.interval
			const indices = Arr.makeBy(output.periods, (index) => index + 1)
			const share = (count: number, size: number): string =>
				size === 0 ? "-" : `${formatNumber(count)} (${formatPercent(count / size)})`
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			// Everything that makes a repeat of this call the same cohorts.
			const steps = {
				...(output.start === undefined ? undefined : { start_json: stringifyJson(output.start) }),
				...(output.return === undefined ? undefined : { return_json: stringifyJson(output.return) }),
				periods: output.periods,
				...(output.firstEver ? undefined : { first_ever: false }),
			}
			const hasOpen = Arr.some(output.cohorts, (cohort) => cohort.completePeriods < output.periods)
			// A cohort whose own interval has not ended has started no period after it.
			const newestOpen = Arr.some(output.cohorts, (cohort) => cohort.startedPeriods === 0)
			return {
				title: `Retention by ${unit} (${noun}; ${stepLabel(output.start)}, then ${stepLabel(output.return)})`,
				scope: [
					["Cohorts", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Returns read through", output.returnsThrough],
					[
						"New means",
						output.firstEver ? "first time ever, over all history" : "first time in this window",
					],
				],
				...(output.identityNote === undefined ? undefined : { notices: [output.identityNote] }),
				...(output.cohorts.length === 0
					? {
							empty: {
								message: `No ${noun} did the start event (${stepLabel(output.start)}) for the first time in this window.`,
								// The notice above already says why; a generic hint would only compete with it.
								hints:
									output.identityNote !== undefined
										? []
										: [
												output.firstEver
													? "With first_ever=true only people new to the start event count. Pass first_ever=false to count everyone active in the window, or widen start_time."
													: "Widen start_time/end_time, or check the event name against `list_product_events`.",
												...(output.keyBy === "person"
													? []
													: [
															`key_by="${output.keyBy}" leaves out events that carry no such id; try key_by="person".`,
														]),
											],
							},
						}
					: undefined),
				blocks:
					output.cohorts.length === 0
						? []
						: [
								doc.table(
									[
										`Cohort (${unit} of)`,
										"Size",
										...Arr.map(indices, (n) => `${unit} ${n}`),
									],
									[
										// First: a long table is cut from the bottom, and this is the row
										// most questions are after.
										[
											"All complete cohorts",
											"",
											...Arr.map(output.overall, (value) =>
												value === null ? "-" : formatPercent(value),
											),
										],
										...Arr.map(output.cohorts, (cohort) => [
											cohort.cohort,
											formatNumber(cohort.size),
											...Arr.map(indices, (n) => {
												// Not started yet is unknown, not zero.
												if (n > cohort.startedPeriods) return "-"
												const cell = share(cohort.returned[n - 1] ?? 0, cohort.size)
												return n > cohort.completePeriods ? `${cell}*` : cell
											}),
										]),
									],
								),
								doc.text(
									`Size is the ${noun} whose first ${stepLabel(output.start)} fell in that ${unit}. A cell is how many of them did ${stepLabel(output.return)} in the ${unit} that many after it, and the share of the cohort. The window is widened to whole ${unit}s, so no cohort is a part of one${newestOpen ? `; the newest ${unit} is not over, so its cohort can still grow` : ""}.`,
								),
								...(hasOpen
									? [
											doc.text(
												`\`-\`: that ${unit} has not started. \`*\`: it is still running, so the count can grow. The first row counts only cohorts old enough to have finished the ${unit}.`,
											),
										]
									: []),
							],
				next: [
					...(output.suggestedKeyBy === undefined
						? []
						: [
								doc.next(
									TOOL,
									{ ...steps, ...window, interval: unit, key_by: output.suggestedKeyBy },
									`the same cohorts counted by ${output.suggestedKeyBy}`,
								),
							]),
					output.keyBy === "group"
						? doc.next(
								TOOL,
								{ ...steps, ...window, interval: unit },
								"the same cohorts counted by person",
							)
						: doc.next(
								TOOL,
								{ ...steps, ...window, interval: unit, key_by: "group" },
								"the same cohorts counted by account",
							),
					doc.next(
						"list_product_events",
						window,
						"see which event names exist for a start or return step",
					),
				],
			}
		},
	})
}
