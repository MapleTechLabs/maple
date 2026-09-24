import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { printResult } from "../lib/output"
import { resolveRangeChecked } from "../core/time"
import * as Ops from "../core/operations"

export const metrics = Command.make("metrics", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	search: f.search,
	limit: f.limit,
}).pipe(
	Command.withDescription("List available metrics"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.listMetrics({
				range,
				service: Option.getOrUndefined(a.service),
				search: Option.getOrUndefined(a.search),
				limit: a.limit,
			})
			yield* printResult(result)
		}),
	),
)

export const query = Command.make("query", {
	sql: Argument.String("sql").pipe(
		Argument.withDescription("Raw ClickHouse SQL to run against the local chDB store"),
	),
}).pipe(
	Command.withDescription("Run raw SQL against local data (escape hatch)"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const result = yield* Ops.rawQuery(a.sql)
			yield* printResult(result)
		}),
	),
)
