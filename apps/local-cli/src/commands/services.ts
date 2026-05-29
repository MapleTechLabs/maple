import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { printJson } from "../lib/output"
import { resolveRange } from "../core/time"
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
			const range = resolveRange({
				since: a.since,
				start: Option.getOrUndefined(a.start),
				end: Option.getOrUndefined(a.end),
			})
			const result = yield* Ops.listServices({ range, environment: Option.getOrUndefined(a.environment) })
			yield* printJson(result)
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
			const range = resolveRange({
				since: a.since,
				start: Option.getOrUndefined(a.start),
				end: Option.getOrUndefined(a.end),
			})
			const result = yield* Ops.diagnoseService({
				serviceName: a.serviceName,
				range,
				environment: Option.getOrUndefined(a.environment),
			})
			yield* printJson(result)
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
			const range = resolveRange({
				since: a.since,
				start: Option.getOrUndefined(a.start),
				end: Option.getOrUndefined(a.end),
			})
			const result = yield* Ops.serviceMap({
				range,
				service: Option.getOrUndefined(a.service),
				environment: Option.getOrUndefined(a.environment),
			})
			yield* printJson(result)
		}),
	),
)
