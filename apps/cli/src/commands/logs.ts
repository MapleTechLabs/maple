import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import { Effect, Option } from "effect"
import * as f from "../lib/flags"
import { logsLink, traceLink, withLogTraceLinks } from "../lib/local-links"
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
	attributes: Flag.Boolean("attributes").pipe(
		Flag.withDescription("Include every log attribute on each entry, not only error keys"),
		Flag.withDefault(false),
	),
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
		{
			command: "maple logs --trace-id 4bf92f3577b34da6a3ce929d0e0e4736 --attributes",
			description: "One request's logs with their structured attributes",
		},
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const filters = {
				service: Option.getOrUndefined(a.service),
				severity: Option.getOrUndefined(a.severity),
				search: Option.getOrUndefined(a.search),
			}
			const traceId = Option.getOrUndefined(a.traceId)
			const environment = Option.getOrUndefined(a.environment)
			const result = yield* Ops.searchLogs({
				range,
				...filters,
				environment,
				traceId,
				limit: a.limit,
				offset: a.offset,
				includeAttributes: a.attributes,
			})
			const output = Option.match(yield* Ops.localUiBase, {
				onNone: () => result,
				onSome: (base) => ({
					// The logs page filters neither by trace nor environment: a trace id
					// links its trace (which lists its logs), an environment gets no link.
					...(traceId !== undefined
						? { url: traceLink(base, traceId) }
						: environment === undefined
							? { url: logsLink(base, { startTime: range.startTime, ...filters }) }
							: {}),
					...result,
					logs: withLogTraceLinks(base, result.logs),
				}),
			})
			yield* printResult(output, logsView(`No logs matched in ${describeWindow(a, range)}`))
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
