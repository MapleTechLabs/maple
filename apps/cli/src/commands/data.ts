import * as Command from "effect/cli/Command"
import * as Argument from "effect/cli/Argument"
import * as Flag from "effect/cli/Flag"
import { Effect, Option, Array as Arr } from "effect"
import * as f from "../lib/flags"
import { CliNotFoundError } from "../lib/errors"
import { printResult } from "../lib/output"
import { metricExemplarsView, metricSeriesView } from "../lib/views"
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
							? `similar names: ${Arr.join(similar, ", ")}`
							: "list the metrics that exist with `maple metrics`",
				})
			}
			yield* printResult(result.output, metricSeriesView(`No data points for ${a.name} in ${window}`))
		}),
	),
)

const exemplars = Command.make("exemplars", {
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
			Flag.withDescription(
				"Bucket size in seconds exemplars are ranked within (default: about 30 buckets)",
			),
			Flag.filter(
				(n) => n >= 1,
				() => "a whole number of seconds, at least 1",
			),
		),
	),
	perBucket: Flag.Int("per-bucket").pipe(
		Flag.withDescription("Exemplars kept per bucket, highest value first (1 to 20)"),
		Flag.withDefault(3),
		Flag.filter(
			(n) => n >= 1 && n <= 20,
			() => "a whole number from 1 to 20",
		),
	),
	limit: f.limit,
}).pipe(
	Command.withDescription(
		"List the traces behind a metric's highest values (the exemplars SDKs record, mostly on histograms); " +
			"open one with `maple trace <trace-id>`",
	),
	Command.withExamples([
		{
			command: "maple metrics exemplars http.server.request.duration --since 1h --format table",
			description: "The slowest requests' traces",
		},
		{
			command: "maple metrics exemplars http.server.request.duration -s checkout --per-bucket 1",
			description: "The top one per bucket for one service",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const window = describeWindow(a, range)
			const bucketSeconds = Option.getOrElse(a.bucket, () => Ops.bucketSecondsFor(range, 30))
			const result = yield* Ops.metricExemplars({
				name: a.name,
				range,
				bucketSeconds,
				service: Option.getOrUndefined(a.service),
				environment: Option.getOrUndefined(a.environment),
				perBucket: a.perBucket,
				limit: a.limit,
			})
			if (result._tag === "missing") {
				const similar = result.similar.slice(0, 5)
				return yield* new CliNotFoundError({
					message: `no metric named '${a.name}' in ${window}`,
					hint:
						similar.length > 0
							? `similar names: ${Arr.join(similar, ", ")}`
							: "list the metrics that exist with `maple metrics`",
				})
			}
			yield* printResult(
				{
					metricName: a.name,
					metricType: result.metricType,
					bucketSeconds,
					exemplars: result.exemplars,
				},
				metricExemplarsView(`No exemplars on ${a.name} in ${window}`),
			)
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
	Command.withSubcommands([show, exemplars]),
)

export const query = Command.make("query", {
	sql: Argument.String("sql").pipe(Argument.withDescription("A read-only ClickHouse SELECT")),
	since: f.since,
	start: f.start,
	end: f.end,
}).pipe(
	Command.withDescription(
		"Run a read-only SQL query (escape hatch). Writes, multiple statements and table functions are rejected. " +
			"Macros expand in both modes: $__orgFilter, $__timeFilter(Column), $__startTime, $__endTime, $__interval_s, " +
			"using the --since/--start/--end window. Remote queries must include $__orgFilter and return at most 100 rows.",
	),
	Command.withExamples([
		{ command: 'maple query "SELECT ServiceName, count() FROM traces GROUP BY ServiceName"' },
		{
			command:
				"maple query 'SELECT ServiceName, count() AS spans FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY ServiceName' --since 1h",
			description: "Runs unchanged locally and remotely (single quotes keep the shell off $__)",
		},
		{ command: 'maple query "SHOW TABLES" --format table' },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.rawQuery({ sql: a.sql, range })
			yield* printResult(result.rows, {
				raw: true,
				empty: "Query returned no rows",
				notes: () =>
					result.truncatedFrom === undefined
						? []
						: [
								`showing ${result.rows.length} of ${result.truncatedFrom} rows; aggregate or add a LIMIT`,
							],
			})
		}),
	),
)
