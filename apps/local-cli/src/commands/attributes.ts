import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import * as Flag from "effect/unstable/cli/Flag"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { printJson } from "../lib/output"
import { resolveRange } from "../core/time"
import * as Ops from "../core/operations"

const source = Flag.choice("source", ["traces", "metrics", "services"]).pipe(
	Flag.withDescription("Attribute source"),
	Flag.withDefault("traces" as const),
)

const scope = Flag.optional(
	Flag.choice("scope", ["span", "resource"]).pipe(
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
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = resolveRange({
				since: a.since,
				start: Option.getOrUndefined(a.start),
				end: Option.getOrUndefined(a.end),
			})
			const result = yield* Ops.attributeKeys({
				source: a.source,
				scope: Option.getOrUndefined(a.scope),
				service: Option.getOrUndefined(a.service),
				range,
				limit: a.limit,
			})
			yield* printJson(result)
		}),
	),
)

const values = Command.make("values", {
	key: Argument.string("key").pipe(Argument.withDescription("Attribute key to list values for")),
	source,
	scope,
	service: f.service,
	since: f.since,
	start: f.start,
	end: f.end,
	limit: f.limit,
}).pipe(
	Command.withDescription("List values for an attribute key"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = resolveRange({
				since: a.since,
				start: Option.getOrUndefined(a.start),
				end: Option.getOrUndefined(a.end),
			})
			const result = yield* Ops.attributeValues({
				key: a.key,
				source: a.source,
				scope: Option.getOrUndefined(a.scope),
				service: Option.getOrUndefined(a.service),
				range,
				limit: a.limit,
			})
			yield* printJson(result)
		}),
	),
)

export const attributes = Command.make("attributes").pipe(
	Command.withDescription("Explore span/resource/metric attribute keys and values"),
	Command.withSubcommands([keys, values]),
)
