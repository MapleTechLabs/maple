import * as Command from "effect/unstable/cli/Command"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { printJson } from "../lib/output"
import { resolveRange } from "../core/time"
import * as Ops from "../core/operations"

export const logs = Command.make("logs", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	severity: f.severity,
	search: f.search,
	traceId: f.traceId,
	limit: f.limit,
	offset: f.offset,
}).pipe(
	Command.withDescription("Search logs with filtering"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = resolveRange({
				since: a.since,
				start: Option.getOrUndefined(a.start),
				end: Option.getOrUndefined(a.end),
			})
			const result = yield* Ops.searchLogs({
				range,
				service: Option.getOrUndefined(a.service),
				severity: Option.getOrUndefined(a.severity),
				search: Option.getOrUndefined(a.search),
				traceId: Option.getOrUndefined(a.traceId),
				limit: a.limit,
				offset: a.offset,
			})
			yield* printJson(result)
		}),
	),
)

export const logPatterns = Command.make("log-patterns", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	severity: f.severity,
	search: f.search,
	limit: f.limit,
}).pipe(
	Command.withDescription("Cluster logs into templates to surface the noisiest patterns"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = resolveRange({
				since: a.since,
				start: Option.getOrUndefined(a.start),
				end: Option.getOrUndefined(a.end),
			})
			const result = yield* Ops.mineLogPatterns({
				range,
				service: Option.getOrUndefined(a.service),
				severity: Option.getOrUndefined(a.severity),
				search: Option.getOrUndefined(a.search),
				limit: a.limit,
			})
			yield* printJson(result)
		}),
	),
)
