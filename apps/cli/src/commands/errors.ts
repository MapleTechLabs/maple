import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { printResult } from "../lib/output"
import { resolveRangeChecked } from "../core/time"
import * as Ops from "../core/operations"

export const errors = Command.make("errors", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
	limit: f.limit,
}).pipe(
	Command.withDescription("List error groups by fingerprint (count, affected services, last seen)"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.findErrors({
				range,
				service: Option.getOrUndefined(a.service),
				environment: Option.getOrUndefined(a.environment),
				limit: a.limit,
			})
			yield* printResult(result)
		}),
	),
)

export const error = Command.make("error", {
	fingerprintHash: Argument.String("fingerprint-hash").pipe(
		Argument.withDescription("Error fingerprint hash (from the `errors` command)"),
	),
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	limit: f.limit,
}).pipe(
	Command.withDescription("Show detail for one error group: sample traces + timeseries"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.errorDetail({
				fingerprintHash: a.fingerprintHash,
				range,
				service: Option.getOrUndefined(a.service),
				limit: a.limit,
			})
			yield* printResult(result)
		}),
	),
)
