import * as Command from "effect/cli/Command"
import * as Argument from "effect/cli/Argument"
import * as Flag from "effect/cli/Flag"
import { Effect, Option, Array as Arr, String as Str } from "effect"
import * as f from "../lib/flags"
import { printResult } from "../lib/output"
import { promqlView } from "../lib/promql-view"
import { describeWindow, resolveRangeChecked } from "../core/time"
import { EXAMPLE_QUERY, evaluationWindow, parseQuery } from "../core/promql"
import * as Ops from "../core/operations"

const since = Flag.String("since").pipe(
	Flag.withDescription("Relative window ending now: 30m, 6h, 7d (default: 1h)"),
	Flag.withDefault("1h"),
)

const metrics = Command.make("metrics", {
	filter: Argument.optional(
		Argument.String("filter").pipe(
			Argument.withDescription("Keep names containing this text (any case)"),
		),
	),
	since: f.since,
	start: f.start,
	end: f.end,
	limit: f.limitWithDefault(200),
}).pipe(
	Command.withDescription(
		"List the Prometheus metric names PromQL can select, e.g. http_server_request_duration_seconds_bucket",
	),
	Command.withExamples([
		{ command: "maple promql metrics http --format table", description: "Names containing http" },
		{ command: "maple promql metrics --since 7d", description: "Every name seen in the last week" },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const filter = Option.map(a.filter, (text) => Str.toLowerCase(Str.trim(text)))
			const all = yield* Ops.promqlMetricNames({ range })
			const matching = Option.match(filter, {
				onNone: () => all,
				onSome: (text) => Arr.filter(all, (name) => Str.includes(text)(Str.toLowerCase(name))),
			})
			const shown = Arr.take(matching, a.limit)
			yield* printResult(
				Arr.map(shown, (name) => ({ name })),
				{
					empty: Option.match(filter, {
						onNone: () => `No metrics in ${describeWindow(a, range)}`,
						onSome: (text) => `No metric names contain "${text}" in ${describeWindow(a, range)}`,
					}),
					notes: () =>
						matching.length > shown.length
							? [
									`showing ${shown.length} of ${matching.length} names; narrow the filter or raise --limit`,
								]
							: [],
				},
			)
		}),
	),
)

export const promql = Command.make("promql", {
	query: Argument.String("query").pipe(
		Argument.withDescription(`PromQL expression, e.g. ${EXAMPLE_QUERY}`),
	),
	since,
	start: f.start,
	end: f.end,
	step: Flag.optional(
		Flag.String("step").pipe(
			Flag.withDescription("Range resolution: 30s, 1m, 1h or seconds (default: 60 to 120 points)"),
		),
	),
	instant: Flag.Boolean("instant").pipe(
		Flag.withDescription("Evaluate once at the window's end instead of over it"),
		Flag.withDefault(false),
	),
}).pipe(
	Command.withDescription(
		"Run a PromQL query over your metrics. Names are Prometheus-style, translated from OTel " +
			"(http.server.request.duration in s is http_server_request_duration_seconds); " +
			"`maple promql metrics` lists them. Prints up to 20 series and the last 200 points of each.",
	),
	Command.withExamples([
		{
			command: `maple promql '${EXAMPLE_QUERY}' --format table`,
			description: "Request rate per service over the last hour",
		},
		{
			command:
				"maple promql 'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))' --since 6h --step 5m",
			description: "p95 latency",
		},
		{ command: "maple promql 'up' --instant", description: "Evaluate once, now" },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const expr = yield* parseQuery(a.query, a.instant)
			const range = yield* resolveRangeChecked(a)
			const step = Option.getOrUndefined(a.step)
			const window = yield* evaluationWindow({
				range,
				instant: a.instant,
				...(step === undefined ? undefined : { step }),
			})
			const output = yield* Ops.promqlQuery({
				query: a.query,
				expr,
				window,
				...(step === undefined ? undefined : { step }),
			})
			yield* printResult(output, promqlView(`No series matched in ${describeWindow(a, range)}`))
		}),
	),
	Command.withSubcommands([metrics]),
)
