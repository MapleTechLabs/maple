import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import * as Flag from "effect/unstable/cli/Flag"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { CliNotFoundError, CliUsageError } from "../lib/errors"
import { printResult } from "../lib/output"
import { slowTracesView, traceView, tracesView } from "../lib/views"
import { describeWindow, resolveRangeChecked } from "../core/time"
import * as Ops from "../core/operations"
import { assertKnownService } from "./services"

const spanName = Flag.optional(
	Flag.String("span-name").pipe(Flag.withDescription("Filter by span name (substring, case-insensitive)")),
)
const minDuration = Flag.optional(
	Flag.Int("min-duration-ms").pipe(Flag.withDescription("Minimum duration in milliseconds")),
)
const maxDuration = Flag.optional(
	Flag.Int("max-duration-ms").pipe(Flag.withDescription("Maximum duration in milliseconds")),
)
const httpMethod = Flag.optional(
	Flag.String("http-method").pipe(Flag.withDescription("Filter by HTTP method (GET, POST, ...)")),
)

export const traces = Command.make("traces", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
	spanName,
	hasError: f.hasError,
	minDuration,
	maxDuration,
	httpMethod,
	limit: f.limit,
	offset: f.offset,
}).pipe(
	Command.withDescription("Search traces (root spans), or individual spans with --span-name"),
	Command.withExamples([
		{
			command: "maple traces -s checkout-service --errors",
			description: "Failed traces for one service",
		},
		{
			command: "maple traces --min-duration-ms 1000 --since 1h",
			description: "Traces slower than a second",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const window = describeWindow(a, range)
			const service = Option.getOrUndefined(a.service)
			const result = yield* Ops.searchTraces({
				range,
				service,
				environment: Option.getOrUndefined(a.environment),
				spanName: Option.getOrUndefined(a.spanName),
				// Only ever `true`: without --errors there is no status filter at all.
				hasError: a.hasError ? true : undefined,
				minDurationMs: Option.getOrUndefined(a.minDuration),
				maxDurationMs: Option.getOrUndefined(a.maxDuration),
				httpMethod: Option.getOrUndefined(a.httpMethod),
				limit: a.limit,
				offset: a.offset,
			})
			if (result.spans.length === 0 && service !== undefined && a.offset === 0) {
				yield* assertKnownService(service, range, window)
			}
			yield* printResult(result, tracesView(`No traces matched in ${window}`))
		}),
	),
)

const TRACE_ID_RE = /^[0-9a-f]{32}$/

export const trace = Command.make("trace", {
	traceId: Argument.String("trace-id").pipe(Argument.withDescription("Trace ID: 32 hex characters")),
	since: Flag.optional(
		Flag.String("since").pipe(
			Flag.withDescription(
				`Look back this far (e.g. 6h, 7d). Default: the last 24h, then up to ${Ops.TRACE_LOOKBACK_DAYS}d`,
			),
		),
	),
	start: f.start,
	end: f.end,
}).pipe(
	Command.withDescription("Inspect a trace: full span tree + correlated logs"),
	Command.withExamples([
		{
			command: "maple trace 4bf92f3577b34da6a3ce929d0e0e4736",
			description: "Span tree and logs for one trace",
		},
		{
			command: "maple trace 4bf92f3577b34da6a3ce929d0e0e4736 --since 7d --format table",
			description: "Search a wider window and print a tree",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const traceId = a.traceId.trim().toLowerCase()
			if (!TRACE_ID_RE.test(traceId)) {
				return yield* new CliUsageError({
					message: `"${a.traceId}" is not a trace id`,
					hint: "trace ids are 32 hex characters, e.g. 4bf92f3577b34da6a3ce929d0e0e4736",
				})
			}
			const explicit = Option.isSome(a.since) || Option.isSome(a.start) || Option.isSome(a.end)
			const windowFlags = { since: Option.getOrElse(a.since, () => "24h"), start: a.start, end: a.end }
			const range = explicit ? yield* resolveRangeChecked(windowFlags) : undefined
			const result = yield* Ops.inspectTrace({
				traceId,
				...(range === undefined ? undefined : { range }),
			})
			if (result.spans.length === 0) {
				const window =
					range === undefined
						? `the last ${Ops.TRACE_LOOKBACK_DAYS}d`
						: describeWindow(windowFlags, range)
				return yield* new CliNotFoundError({
					message: `trace ${traceId} not found in ${window}`,
					hint:
						range === undefined
							? "pass --start/--end to search an older window"
							: "try a wider window, e.g. --since 7d",
				})
			}
			yield* printResult(result, traceView)
		}),
	),
)

export const slowTraces = Command.make("slow-traces", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
	limit: f.limit,
}).pipe(
	Command.withDescription("Find the slowest traces with duration stats"),
	Command.withExamples([
		{ command: "maple slow-traces --since 1h", description: "Slowest traces in the last hour" },
		{ command: "maple slow-traces -s api -n 5 --format table", description: "Top five for one service" },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.findSlowTraces({
				range,
				service: Option.getOrUndefined(a.service),
				environment: Option.getOrUndefined(a.environment),
				limit: a.limit,
			})
			yield* printResult(result, slowTracesView(`No traces in ${describeWindow(a, range)}`))
		}),
	),
)
