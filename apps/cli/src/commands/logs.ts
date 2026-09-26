import * as Command from "effect/unstable/cli/Command"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { printResult } from "../lib/output"
import { logPatternsView, logsView } from "../lib/views"
import { describeWindow, resolveRangeChecked } from "../core/time"
import * as Ops from "../core/operations"

export const logs = Command.make("logs", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
	severity: f.severity,
	search: f.search,
	traceId: f.traceId,
	limit: f.limit,
	offset: f.offset,
}).pipe(
	Command.withDescription("Search logs with filtering"),
	Command.withExamples([
		{
			command: "maple logs -s checkout-service --severity error",
			description: "Error logs from one service",
		},
		{
			command: 'maple logs -q "timed out" --since 1h --format table',
			description: "Full-text search, readable",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.searchLogs({
				range,
				service: Option.getOrUndefined(a.service),
				environment: Option.getOrUndefined(a.environment),
				severity: Option.getOrUndefined(a.severity),
				search: Option.getOrUndefined(a.search),
				traceId: Option.getOrUndefined(a.traceId),
				limit: a.limit,
				offset: a.offset,
			})
			yield* printResult(result, logsView(`No logs matched in ${describeWindow(a, range)}`))
		}),
	),
)

export const logPatterns = Command.make("log-patterns", {
	since: f.since,
	start: f.start,
	end: f.end,
	service: f.service,
	environment: f.environment,
	severity: f.severity,
	search: f.search,
	limit: f.limit,
}).pipe(
	Command.withDescription("Cluster logs into templates to surface the noisiest patterns"),
	Command.withExamples([
		{ command: "maple log-patterns --since 1h", description: "Noisiest log templates in the last hour" },
		{
			command: "maple log-patterns --severity warn -n 10 --format table",
			description: "Top warning patterns",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.mineLogPatterns({
				range,
				service: Option.getOrUndefined(a.service),
				environment: Option.getOrUndefined(a.environment),
				severity: Option.getOrUndefined(a.severity),
				search: Option.getOrUndefined(a.search),
				limit: a.limit,
			})
			yield* printResult(result, logPatternsView(`No logs to cluster in ${describeWindow(a, range)}`))
		}),
	),
)
