import * as Command from "effect/cli/Command"
import * as Argument from "effect/cli/Argument"
import * as Flag from "effect/cli/Flag"
import { Effect, Option } from "effect"
import type { TracesMetric } from "@maple/query-engine"
import * as f from "../lib/flags"
import { CliNotFoundError } from "../lib/errors"
import { isEmptyResult, printResult } from "../lib/output"
import { diagnoseView, serviceMapView, servicesView, topOpsView } from "../lib/views"
import { describeWindow, resolveRangeChecked, type Range } from "../core/time"
import * as Ops from "../core/operations"

/**
 * A service name with no trace telemetry in the window is almost always a typo,
 * so name the ones that do exist instead of printing zeros that look real.
 */
export const assertKnownService = (service: string, range: Range, window: string) =>
	Effect.gen(function* () {
		if (yield* Ops.serviceHasTelemetry(service, range)) return
		const known = yield* Ops.knownServices(range)
		const shown = known.slice(0, 8)
		return yield* new CliNotFoundError({
			message: `no telemetry for '${service}' in ${window}`,
			hint:
				known.length === 0
					? "no service reported traces in that window; widen it with --since"
					: `known services: ${shown.join(", ")}${known.length > shown.length ? `, +${known.length - shown.length} more` : ""}`,
		})
	})

export const services = Command.make("services", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: Flag.optional(
		Flag.String("service").pipe(
			Flag.withAlias("s"),
			Flag.withDescription("Only services whose name contains this text"),
		),
	),
	environment: f.environment,
	limit: f.limitWithDefault(50),
}).pipe(
	Command.withDescription("List active services with throughput, error rate, and latency percentiles"),
	Command.withExamples([
		{
			command: "maple services --since 1h --format table",
			description: "Busiest services in the last hour",
		},
		{
			command: "maple services -s checkout --env production",
			description: "Filter by name and environment",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const needle = Option.getOrUndefined(a.service)?.toLowerCase()
			const all = yield* Ops.listServices({ range, environment: Option.getOrUndefined(a.environment) })
			const matching = [...all]
				.filter((s) => needle === undefined || s.name.toLowerCase().includes(needle))
				.sort((x, y) => y.throughput - x.throughput)
			const shown = matching.slice(0, a.limit)
			yield* printResult(shown, {
				...servicesView(`No services with traces in ${describeWindow(a, range)}`),
				notes: () =>
					matching.length > shown.length
						? [
								`showing ${shown.length} of ${matching.length} services; raise --limit to see more`,
							]
						: [],
			})
		}),
	),
)

export const diagnose = Command.make("diagnose", {
	serviceName: Argument.String("service-name").pipe(Argument.withDescription("Service to diagnose")),
	since: f.since,
	start: f.start,
	end: f.end,
	environment: f.environment,
}).pipe(
	Command.withDescription("Deep-dive a service: health, top errors, recent traces and logs"),
	Command.withExamples([
		{ command: "maple diagnose checkout-service", description: "Health of one service over the last 6h" },
		{
			command: "maple diagnose api --since 30m --format table",
			description: "Readable summary for a recent window",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.diagnoseService({
				serviceName: a.serviceName,
				range,
				environment: Option.getOrUndefined(a.environment),
			})
			const silent =
				result.health.throughput === 0 &&
				result.topErrors.length === 0 &&
				result.recentTraces.length === 0 &&
				result.recentLogs.length === 0
			if (silent) yield* assertKnownService(a.serviceName, range, describeWindow(a, range))
			yield* printResult(result, diagnoseView)
		}),
	),
)

const TOP_OPS_METRICS = [
	"count",
	"avg_duration",
	"p50_duration",
	"p95_duration",
	"p99_duration",
	"error_rate",
	"apdex",
] as const satisfies ReadonlyArray<TracesMetric>

export const topOps = Command.make("top-ops", {
	serviceName: Argument.String("service-name").pipe(Argument.withDescription("Service to inspect")),
	metric: Flag.Literals("metric", TOP_OPS_METRICS).pipe(
		Flag.withDescription("Ranking metric (default: count)"),
		Flag.withDefault("count"),
	),
	since: f.since,
	start: f.start,
	end: f.end,
	limit: f.limit,
}).pipe(
	Command.withDescription("Top operations (span names) for a service, ranked by a metric"),
	Command.withExamples([
		{ command: "maple top-ops checkout-service", description: "Busiest operations by span count" },
		{
			command: "maple top-ops api --metric p95_duration -n 5",
			description: "Five slowest operations by p95",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const window = describeWindow(a, range)
			const result = yield* Ops.topOperations({
				serviceName: a.serviceName,
				metric: a.metric,
				range,
				limit: a.limit,
			})
			if (result.length === 0) yield* assertKnownService(a.serviceName, range, window)
			yield* printResult(result, topOpsView(`No operations for '${a.serviceName}' in ${window}`))
		}),
	),
)

export const serviceMap = Command.make("service-map", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
}).pipe(
	Command.withDescription(
		"Service dependency edges and the databases services call (call counts, errors, latency)",
	),
	Command.withExamples([
		{ command: "maple service-map --format table", description: "Every edge seen in the last 6h" },
		{
			command: "maple service-map -s checkout-service",
			description: "Edges touching one service, plus its databases and external calls",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const service = Option.getOrUndefined(a.service)
			const window = describeWindow(a, range)
			const result = yield* Ops.serviceMap({
				range,
				service,
				environment: Option.getOrUndefined(a.environment),
			})
			if (service !== undefined && isEmptyResult(result))
				yield* assertKnownService(service, range, window)
			// Remote mode never queried databases or external calls, so an empty map must say so.
			const empty =
				result.databases === undefined
					? `No service-to-service calls in ${window}; databases and external calls are only listed in local mode`
					: `No dependencies in ${window}`
			yield* printResult(result, serviceMapView(empty))
		}),
	),
)
