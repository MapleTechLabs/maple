import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import * as Flag from "effect/unstable/cli/Flag"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { CliNotFoundError } from "../lib/errors"
import { printResult } from "../lib/output"
import { metricSeriesView } from "../lib/views"
import { describeWindow, resolveRangeChecked } from "../core/time"
import * as Ops from "../core/operations"

const show = Command.make("show", {
	name: Argument.String("metric-name").pipe(
		Argument.withDescription("Exact metric name (see `maple metrics`)"),
	),
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
	bucket: Flag.optional(
		Flag.Int("bucket").pipe(
			Flag.withDescription("Bucket size in seconds (default: about 60 buckets over the window)"),
			Flag.filter(
				(n) => n >= 1,
				() => "a whole number of seconds, at least 1",
			),
		),
	),
}).pipe(
	Command.withDescription(
		"Read one metric's values over time, per service (counters as a per-second rate, others as the average)",
	),
	Command.withExamples([
		{ command: "maple metrics show http.server.request.count", description: "Request rate per service" },
		{
			command: "maple metrics show checkout.queue.depth --since 1h --format table",
			description: "A gauge",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const window = describeWindow(a, range)
			const result = yield* Ops.metricSeries({
				name: a.name,
				range,
				bucketSeconds: Option.getOrElse(a.bucket, () => Ops.bucketSecondsFor(range)),
				service: Option.getOrUndefined(a.service),
				environment: Option.getOrUndefined(a.environment),
			})
			if (result._tag === "missing") {
				const similar = result.similar.slice(0, 5)
				return yield* new CliNotFoundError({
					message: `no metric named '${a.name}' in ${window}`,
					hint:
						similar.length > 0
							? `similar names: ${similar.join(", ")}`
							: "list the metrics that exist with `maple metrics`",
				})
			}
			yield* printResult(result.output, metricSeriesView(`No data points for ${a.name} in ${window}`))
		}),
	),
)

export const metrics = Command.make("metrics", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	search: f.search,
	limit: f.limit,
}).pipe(
	Command.withDescription("List available metrics; `maple metrics show <name>` reads one metric's values"),
	Command.withExamples([
		{ command: "maple metrics -q http --format table", description: "Metrics whose name contains http" },
		{
			command: "maple metrics show http.server.request.count --since 1h",
			description: "Values over time",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.listMetrics({
				range,
				service: Option.getOrUndefined(a.service),
				search: Option.getOrUndefined(a.search),
				limit: a.limit,
			})
			yield* printResult(result, { empty: `No metrics in ${describeWindow(a, range)}` })
		}),
	),
	Command.withSubcommands([show]),
)

export const query = Command.make("query", {
	sql: Argument.String("sql").pipe(
		Argument.withDescription("A read-only ClickHouse SELECT to run against the local chDB store"),
	),
}).pipe(
	Command.withDescription(
		"Run a read-only SQL query against local data (escape hatch). Writes, multiple statements and table functions are rejected.",
	),
	Command.withExamples([
		{ command: 'maple query "SELECT ServiceName, count() FROM traces GROUP BY ServiceName"' },
		{ command: 'maple query "SHOW TABLES" --format table' },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const result = yield* Ops.rawQuery(a.sql)
			yield* printResult(result, { raw: true, empty: "Query returned no rows" })
		}),
	),
)
