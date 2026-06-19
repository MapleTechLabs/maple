import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import * as Flag from "effect/unstable/cli/Flag"
import { Effect, Option } from "effect"
import type { TracesMetric } from "@maple/query-engine"
import * as f from "../lib/flags"
import { printResult } from "../lib/output"
import { resolveRangeChecked } from "../core/time"
import * as Ops from "../core/operations"

export const services = Command.make("services", {
	since: f.since,
	start: f.start,
	end: f.end,
	environment: f.environment,
}).pipe(
	Command.withDescription("List active services with throughput, error rate, and P95 latency"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.listServices({
				range,
				environment: Option.getOrUndefined(a.environment),
			})
			yield* printResult(result)
		}),
	),
)

export const diagnose = Command.make("diagnose", {
	serviceName: Argument.string("service-name").pipe(Argument.withDescription("Service to diagnose")),
	since: f.since,
	start: f.start,
	end: f.end,
	environment: f.environment,
}).pipe(
	Command.withDescription("Deep-dive a service: health, top errors, recent traces and logs"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.diagnoseService({
				serviceName: a.serviceName,
				range,
				environment: Option.getOrUndefined(a.environment),
			})
			yield* printResult(result)
		}),
	),
)

export const topOps = Command.make("top-ops", {
	serviceName: Argument.string("service-name").pipe(Argument.withDescription("Service to inspect")),
	metric: Flag.choice("metric", [
		"count",
		"avg_duration",
		"p50_duration",
		"p95_duration",
		"p99_duration",
		"error_rate",
		"apdex",
	]).pipe(Flag.withDescription("Ranking metric"), Flag.withDefault("count")),
	since: f.since,
	start: f.start,
	end: f.end,
	limit: f.limit,
}).pipe(
	Command.withDescription("Top operations (span names) for a service, ranked by a metric"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.topOperations({
				serviceName: a.serviceName,
				metric: a.metric as TracesMetric,
				range,
				limit: a.limit,
			})
			yield* printResult(result)
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
	Command.withDescription("Service dependency edges (call counts, errors, latency)"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.serviceMap({
				range,
				service: Option.getOrUndefined(a.service),
				environment: Option.getOrUndefined(a.environment),
			})
			yield* printResult(result)
		}),
	),
)
