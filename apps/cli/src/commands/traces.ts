import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import * as Flag from "effect/unstable/cli/Flag"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { printJson } from "../lib/output"
import { resolveRange } from "../core/time"
import * as Ops from "../core/operations"

const spanName = Flag.optional(
	Flag.string("span-name").pipe(Flag.withDescription("Filter by span name (substring, case-insensitive)")),
)
const minDuration = Flag.optional(
	Flag.integer("min-duration-ms").pipe(Flag.withDescription("Minimum duration in milliseconds")),
)
const maxDuration = Flag.optional(
	Flag.integer("max-duration-ms").pipe(Flag.withDescription("Maximum duration in milliseconds")),
)
const httpMethod = Flag.optional(
	Flag.string("http-method").pipe(Flag.withDescription("Filter by HTTP method (GET, POST, ...)")),
)

export const traces = Command.make("traces", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	spanName,
	hasError: f.hasError,
	minDuration,
	maxDuration,
	httpMethod,
	limit: f.limit,
	offset: f.offset,
}).pipe(
	Command.withDescription("Search traces/spans in local Maple"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = resolveRange({
				since: a.since,
				start: Option.getOrUndefined(a.start),
				end: Option.getOrUndefined(a.end),
			})
			const result = yield* Ops.searchTraces({
				range,
				service: Option.getOrUndefined(a.service),
				spanName: Option.getOrUndefined(a.spanName),
				hasError: a.hasError || undefined,
				minDurationMs: Option.getOrUndefined(a.minDuration),
				maxDurationMs: Option.getOrUndefined(a.maxDuration),
				httpMethod: Option.getOrUndefined(a.httpMethod),
				limit: a.limit,
				offset: a.offset,
			})
			yield* printJson(result)
		}),
	),
)

export const trace = Command.make("trace", {
	traceId: Argument.string("trace-id").pipe(Argument.withDescription("Trace ID to inspect")),
}).pipe(
	Command.withDescription("Inspect a trace: full span tree + correlated logs"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const result = yield* Ops.inspectTrace({ traceId: a.traceId })
			yield* printJson(result)
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
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = resolveRange({
				since: a.since,
				start: Option.getOrUndefined(a.start),
				end: Option.getOrUndefined(a.end),
			})
			const result = yield* Ops.findSlowTraces({
				range,
				service: Option.getOrUndefined(a.service),
				environment: Option.getOrUndefined(a.environment),
				limit: a.limit,
			})
			yield* printJson(result)
		}),
	),
)
