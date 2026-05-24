import {
	requiredStringParam,
	McpQueryError,
	type McpToolRegistrar,
} from "./types"
import { withTenantExecutor, resolveTenant } from "../lib/query-warehouse"
import { truncate } from "../lib/format"
import { formatNextSteps } from "../lib/next-steps"
import { Array as Arr, Effect, Schema, pipe } from "effect"
import { createDualContent } from "../lib/structured-output"
import {
	getSessionTranscript,
	type SessionTranscriptOutput,
} from "@maple/query-engine/observability"

export function registerGetSessionTranscriptTool(server: McpToolRegistrar) {
	server.tool(
		"get_session_transcript",
		"Read a browser session replay as a compact text transcript: navigation, clicks, console logs, network requests, and errors in order, each with the trace id it occurred under. Use after `search_sessions` to analyze what a user did and what went wrong. Drill into any referenced trace with `inspect_trace`.",
		Schema.Struct({
			session_id: requiredStringParam("The session id to read (from search_sessions)"),
		}),
		Effect.fn("McpTool.getSessionTranscript")(function* ({ session_id }) {
			const tenant = yield* resolveTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, sessionId: session_id })

			const events = (yield* withTenantExecutor(
				getSessionTranscript({ sessionId: session_id }),
			).pipe(
				Effect.catchTag("@maple/query-engine/errors/ObservabilityError", (e) =>
					Effect.fail(
						new McpQueryError({
							message: e.message,
							pipe: e.pipe ?? "get_session_transcript",
							cause: e,
						}),
					),
				),
			))

			yield* Effect.annotateCurrentSpan("eventCount", events.length)
			if (events.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No distilled events for session ${session_id}. The session may predate event capture, or only have a visual (rrweb) recording.`,
						},
					],
				}
			}

			const lines: string[] = [`## Session ${session_id} (${events.length} events)`, ``]
			for (const ev of events) {
				lines.push(formatLine(ev))
			}

			// Surface a few distinct trace ids for drill-down.
			const distinctTraces = [...new Set(events.map((e) => e.traceId).filter(Boolean))].slice(0, 3)
			const nextSteps = distinctTraces.map(
				(id) => `\`inspect_trace trace_id="${id}"\` — backend trace for a request in this session`,
			)
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "get_session_transcript",
					data: {
						sessionId: session_id,
						events: pipe(
							events,
							Arr.map((e) => ({
								timestamp: e.timestamp,
								type: e.type,
								url: e.url,
								traceId: e.traceId,
								level: e.level,
								message: e.message,
								targetSelector: e.targetSelector,
								netMethod: e.netMethod,
								netUrl: e.netUrl,
								netStatus: e.netStatus,
								netDurationMs: e.netDurationMs,
							})),
						),
					},
				}),
			}
		}),
	)
}

/** Render one transcript row as `time · TYPE detail (trace)`. */
function formatLine(ev: SessionTranscriptOutput): string {
	const time = ev.timestamp.split(" ")[1] ?? ev.timestamp
	const trace = ev.traceId ? ` ⟶ ${ev.traceId.slice(0, 12)}…` : ""
	let detail: string
	switch (ev.type) {
		case "navigation":
			detail = `NAV   → ${ev.url}`
			break
		case "click":
			detail = `CLICK ${ev.targetSelector}${ev.targetText ? ` "${truncate(ev.targetText, 60)}"` : ""}`
			break
		case "input":
			detail = `INPUT ${ev.targetSelector}`
			break
		case "console":
			detail = `LOG   [${ev.level || "log"}] ${truncate(ev.message, 200)}`
			break
		case "network":
			detail = `NET   ${ev.netMethod} ${ev.netStatus} ${truncate(ev.netUrl, 100)} (${ev.netDurationMs}ms)`
			break
		case "error":
			detail = `ERROR ${truncate(ev.message, 200)}`
			break
		default:
			detail = `${ev.type} ${truncate(ev.message, 120)}`
	}
	return `${time}  ${detail}${trace}`
}
