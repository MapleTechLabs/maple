import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import * as Flag from "effect/unstable/cli/Flag"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { printResult } from "../lib/output"
import { describeWindow, resolveRangeChecked } from "../core/time"
import * as Ops from "../core/operations"

const source = Flag.Literals("source", ["traces", "metrics", "services"]).pipe(
	Flag.withDescription("Attribute source"),
	Flag.withDefault("traces" as const),
)

const scope = Flag.optional(
	Flag.Literals("scope", ["span", "resource"]).pipe(
		Flag.withDescription("Attribute scope for traces (default: span)"),
	),
)

const keys = Command.make("keys", {
	source,
	scope,
	service: f.service,
	since: f.since,
	start: f.start,
	end: f.end,
	limit: f.limit,
}).pipe(
	Command.withDescription("Discover available attribute keys"),
	Command.withExamples([
		{ command: "maple attributes keys", description: "Span attribute keys seen in the last 6h" },
		{
			command: "maple attributes keys --scope resource -s api",
			description: "Resource keys for one service",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.attributeKeys({
				source: a.source,
				scope: Option.getOrUndefined(a.scope),
				service: Option.getOrUndefined(a.service),
				range,
				limit: a.limit,
			})
			yield* printResult(result, { empty: `No attribute keys in ${describeWindow(a, range)}` })
		}),
	),
)

const values = Command.make("values", {
	key: Argument.String("key").pipe(Argument.withDescription("Attribute key to list values for")),
	source,
	scope,
	service: f.service,
	since: f.since,
	start: f.start,
	end: f.end,
	limit: f.limit,
}).pipe(
	Command.withDescription("List values for an attribute key"),
	Command.withExamples([
		{ command: "maple attributes values http.route", description: "Routes seen in the last 6h" },
		{ command: "maple attributes values deployment.environment --scope resource" },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.attributeValues({
				key: a.key,
				source: a.source,
				scope: Option.getOrUndefined(a.scope),
				service: Option.getOrUndefined(a.service),
				range,
				limit: a.limit,
			})
			yield* printResult(result, { empty: `No values for ${a.key} in ${describeWindow(a, range)}` })
		}),
	),
)

export const attributes = Command.make("attributes").pipe(
	Command.withDescription("Explore span/resource/metric attribute keys and values"),
	Command.withSubcommands([keys, values]),
)
