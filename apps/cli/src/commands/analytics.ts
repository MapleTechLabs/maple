import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { CliUsageError } from "../lib/errors"
import { printResult } from "../lib/output"
import { compareView } from "../lib/views"
import {
	describeWindow,
	formatDateTimeUTC,
	normalizeTimestamp,
	parseTimestampMs,
	resolveRangeChecked,
	TimeRangeError,
	type Range,
} from "../core/time"
import * as Ops from "../core/operations"

const spanName = Flag.optional(Flag.String("span-name").pipe(Flag.withDescription("Filter by span name")))
const errorsOnly = Flag.Boolean("errors").pipe(
	Flag.withDescription("Only include errored spans"),
	Flag.withDefault(false),
)
const bucket = Flag.optional(
	Flag.Int("bucket").pipe(
		Flag.withDescription("Bucket size in seconds (default: 60)"),
		Flag.filter(
			(n) => n >= 1,
			() => "a whole number of seconds, at least 1",
		),
	),
)

export const timeseries = Command.make("timeseries", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
	span: spanName,
	groupBy: Flag.Literals("group-by", ["none", "service", "span_name", "status_code", "http_method"]).pipe(
		Flag.withDescription("Group series by dimension (default: none)"),
		Flag.withDefault("none"),
	),
	errors: errorsOnly,
	bucket,
}).pipe(
	Command.withDescription(
		"Time-bucketed trace metrics (count, latency quantiles, error rate, apdex emitted per bucket)",
	),
	Command.withExamples([
		{
			command: "maple timeseries --since 1h --bucket 300",
			description: "Five-minute buckets over an hour",
		},
		{ command: "maple timeseries --group-by service --errors", description: "Errored spans per service" },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.tracesTimeseries({
				range,
				service: Option.getOrUndefined(a.service),
				spanName: Option.getOrUndefined(a.span),
				groupBy: a.groupBy,
				errorsOnly: a.errors,
				environment: Option.getOrUndefined(a.environment),
				bucketSeconds: Option.getOrUndefined(a.bucket),
			})
			yield* printResult(result, { empty: `No spans in ${describeWindow(a, range)}` })
		}),
	),
)

export const breakdown = Command.make("breakdown", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
	span: spanName,
	groupBy: Flag.Literals("group-by", ["service", "span_name", "status_code", "http_method"]).pipe(
		Flag.withDescription("Group results by dimension (default: span_name)"),
		Flag.withDefault("span_name"),
	),
	errors: errorsOnly,
	limit: f.limit,
}).pipe(
	Command.withDescription("Top-N trace breakdown by dimension (service, span, status code, http method)"),
	Command.withExamples([
		{ command: "maple breakdown -s checkout-service", description: "Busiest operations of one service" },
		{
			command: "maple breakdown --group-by status_code --errors",
			description: "Error spans by status code",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.tracesBreakdown({
				range,
				service: Option.getOrUndefined(a.service),
				spanName: Option.getOrUndefined(a.span),
				groupBy: a.groupBy,
				errorsOnly: a.errors,
				environment: Option.getOrUndefined(a.environment),
				limit: a.limit,
			})
			yield* printResult(result, { empty: `No spans in ${describeWindow(a, range)}` })
		}),
	),
)

const WINDOW_MS = 30 * 60 * 1000

const COMPARE_USAGE =
	"pass --around <time>, or all four of --current-start --current-end --previous-start --previous-end"

const windowFlag = (name: string, description: string) =>
	Flag.optional(Flag.String(name).pipe(Flag.withDescription(description)))

/** Both bounds of one compare window, normalized and ordered. */
const compareWindow = (label: string, startFlag: string, endFlag: string, start: string, end: string) =>
	Effect.gen(function* () {
		const startTime = yield* Effect.fromResult(normalizeTimestamp(start, startFlag))
		const endTime = yield* Effect.fromResult(normalizeTimestamp(end, endFlag))
		if (startTime >= endTime) {
			return yield* new TimeRangeError({
				message: `the ${label} window is empty: ${startFlag} ${startTime} is not before ${endFlag} ${endTime}`,
				hint: COMPARE_USAGE,
			})
		}
		return { startTime, endTime } satisfies Range
	})

export const compare = Command.make("compare", {
	around: windowFlag(
		"around",
		"Compare the 30m before vs the 30m after this time ('YYYY-MM-DD HH:mm:ss' UTC or ISO-8601)",
	),
	currentStart: windowFlag("current-start", "Start of the window under suspicion (the 'after' side)"),
	currentEnd: windowFlag("current-end", "End of the window under suspicion"),
	previousStart: windowFlag("previous-start", "Start of the baseline window to compare against"),
	previousEnd: windowFlag("previous-end", "End of the baseline window"),
	environment: f.environment,
}).pipe(
	Command.withDescription("Compare service health between two time windows (regression detection)"),
	Command.withExamples([
		{
			command: 'maple compare --around "2026-09-25 22:00:00"',
			description: "Half an hour before a deploy vs half an hour after",
		},
		{
			command:
				'maple compare --previous-start "2026-09-24 10:00:00" --previous-end "2026-09-24 11:00:00" --current-start "2026-09-25 10:00:00" --current-end "2026-09-25 11:00:00"',
			description: "Same hour, yesterday vs today",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const around = Option.getOrUndefined(a.around)
			const cs = Option.getOrUndefined(a.currentStart)
			const ce = Option.getOrUndefined(a.currentEnd)
			const ps = Option.getOrUndefined(a.previousStart)
			const pe = Option.getOrUndefined(a.previousEnd)
			const anyWindowFlag = cs !== undefined || ce !== undefined || ps !== undefined || pe !== undefined

			let current: Range
			let previous: Range
			if (around !== undefined) {
				if (anyWindowFlag) {
					return yield* new CliUsageError({
						message: "--around cannot be combined with the explicit window flags",
						hint: COMPARE_USAGE,
					})
				}
				const t = parseTimestampMs(around)
				if (t === null) {
					return yield* new TimeRangeError({
						message: `invalid --around "${around}": expected 'YYYY-MM-DD HH:mm:ss' (UTC) or ISO-8601`,
						hint: "for example --around 2026-09-25T22:00:00Z",
					})
				}
				const at = (ms: number) => formatDateTimeUTC(new Date(ms))
				current = { startTime: at(t), endTime: at(t + WINDOW_MS) }
				previous = { startTime: at(t - WINDOW_MS), endTime: at(t) }
			} else {
				if (cs === undefined || ce === undefined || ps === undefined || pe === undefined) {
					return yield* new CliUsageError({
						message: anyWindowFlag
							? "compare needs all four window flags"
							: "compare needs two windows",
						hint: COMPARE_USAGE,
					})
				}
				current = yield* compareWindow("current", "--current-start", "--current-end", cs, ce)
				previous = yield* compareWindow("previous", "--previous-start", "--previous-end", ps, pe)
			}

			const result = yield* Ops.compareServiceOverview({
				current,
				previous,
				environment: Option.getOrUndefined(a.environment),
			})
			yield* printResult(
				result,
				compareView(
					`No service traffic in either window (${previous.startTime} to ${current.endTime} UTC)`,
				),
			)
		}),
	),
)
