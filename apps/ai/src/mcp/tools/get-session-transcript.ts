import { Effect, Schema } from "effect"
import { GetSessionTranscriptOutput, SessionTranscriptEventType } from "@maple/domain/mcp-outputs"
import { getSessionTranscript } from "@maple/query-engine/observability"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

type TranscriptEvent = (typeof GetSessionTranscriptOutput.Type.events)[number]
type TranscriptFilters = typeof GetSessionTranscriptOutput.Type.filters
type EventType = typeof SessionTranscriptEventType.Type

const isEventType = Schema.is(SessionTranscriptEventType)

/** Human-readable summary of the active filters, for the scope line and the empty message. */
const describeFilters = (filters: TranscriptFilters): string => {
	const parts: string[] = []
	if (filters.onlyErrors) parts.push("errors only")
	if (filters.eventTypes.length > 0) parts.push(`types=${filters.eventTypes.join("/")}`)
	if (filters.aroundTraceId !== undefined) parts.push(`trace=${filters.aroundTraceId.slice(0, 12)}…`)
	return parts.join(", ")
}

/** One transcript row as `time  TYPE detail (trace)`. */
const formatLine = (ev: TranscriptEvent): string => {
	const time = ev.timestamp.split(" ")[1] ?? ev.timestamp
	const trace = ev.traceId ? ` ⟶ ${ev.traceId.slice(0, 12)}…` : ""
	const detail = (() => {
		switch (ev.type) {
			case "navigation":
				return `NAV   → ${ev.url}`
			case "click":
				return `CLICK ${ev.targetSelector}${ev.targetText ? ` "${truncate(ev.targetText, 60)}"` : ""}`
			case "input":
				return `INPUT ${ev.targetSelector}`
			case "console":
				return `LOG   [${ev.level || "log"}] ${truncate(ev.message, 200)}`
			case "network":
				return `NET   ${ev.netMethod} ${ev.netStatus} ${truncate(ev.netUrl, 100)} (${ev.netDurationMs}ms)`
			case "error":
				return `ERROR ${truncate(ev.message, 200)}`
			default:
				return `${ev.type} ${truncate(ev.message, 120)}`
		}
	})()
	return `${time}  ${detail}${trace}`
}

export function registerGetSessionTranscriptTool(server: McpToolRegistrar) {
	server.define({
		name: "get_session_transcript",
		description:
			"Browser session replays (end-user web sessions), not AI agent sessions: for those use `list_agent_sessions`. Read a browser session replay as a compact text transcript: navigation, clicks, console logs, network requests, and errors in order, each with the trace id it occurred under. Use after `search_sessions` to analyze what a user did and what went wrong. Returns one page of events: narrow with `only_errors`, `event_types`, or `around_trace_id`, or page through with `offset`. Drill into any referenced trace with `inspect_trace`.",
		parameters: Schema.Struct({
			session_id: P.text("The session id to read (from search_sessions)"),
			event_types: P.optionalList(
				"Event types to include: navigation, click, input, console, network, error. Omit for all.",
			),
			only_errors: P.optionalFlag(
				"If true, only show what went wrong: error events, console errors, and failed (status >= 400) requests.",
			),
			around_trace_id: P.optionalText(
				"Only events that occurred under this trace id (focus on one backend request).",
			),
			offset: P.offset({ max: 10_000 }),
			limit: P.limit({ default: 100, max: 250, noun: "events" }),
		}),
		output: GetSessionTranscriptOutput,
		hints: { readOnly: true },
		phrases: ["Reading a session transcript"],
		handler: Effect.fn("McpTool.getSessionTranscript")(function* (params) {
			const requested = [
				...new Set((params.event_types ?? []).map((type) => type.trim().toLowerCase())),
			]
			const unknown = requested.filter((type) => !isEventType(type))
			if (unknown.length > 0) {
				return yield* new McpInvalidInputError({
					message: `Unknown event type ${unknown.map((type) => `"${type}"`).join(", ")}. Valid types: ${SessionTranscriptEventType.literals.join(", ")}.`,
					parameter: "event_types",
					example: '["console","error"]',
				})
			}
			const types: ReadonlyArray<EventType> = requested.filter(isEventType)
			const errorsOnly = params.only_errors ?? false
			const lim = params.limit
			const off = params.offset

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				sessionId: params.session_id,
				limit: lim,
				offset: off,
				errorsOnly,
			})

			// Fetch one extra row to detect whether more events remain past this page.
			const rows = yield* withTenantExecutor(
				getSessionTranscript({
					sessionId: params.session_id,
					types: types.length > 0 ? types : undefined,
					traceId: params.around_trace_id,
					errorsOnly,
					limit: lim + 1,
					offset: off,
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers("get_session_transcript")))

			const hasMore = rows.length > lim
			const events = hasMore ? rows.slice(0, lim) : rows
			yield* Effect.annotateCurrentSpan("eventCount", events.length)

			return {
				sessionId: params.session_id,
				events: events.map((e) => ({
					timestamp: e.timestamp,
					type: e.type,
					url: truncate(e.url, 256),
					traceId: e.traceId,
					level: e.level,
					message: truncate(e.message, 500),
					targetSelector: e.targetSelector,
					targetText: truncate(e.targetText, 256),
					netMethod: e.netMethod,
					netUrl: truncate(e.netUrl, 256),
					netStatus: Number(e.netStatus),
					netDurationMs: Number(e.netDurationMs),
				})),
				pagination: {
					offset: off,
					limit: lim,
					hasMore,
					...(hasMore ? { nextOffset: off + lim } : undefined),
				},
				filters: {
					eventTypes: types,
					onlyErrors: errorsOnly,
					...(params.around_trace_id === undefined
						? undefined
						: { aroundTraceId: params.around_trace_id }),
				},
			}
		}),
		render: (output) => {
			const { events, pagination, filters } = output
			const filterNote = describeFilters(filters)
			// Surface a few distinct trace ids for drill-down.
			const traces = [...new Set(events.map((e) => e.traceId).filter(Boolean))].slice(0, 3)
			return {
				title: `Session ${output.sessionId}`,
				scope: [
					[
						"Events",
						events.length === 0
							? undefined
							: `${pagination.offset + 1} to ${pagination.offset + events.length}`,
					],
					["Filter", filterNote === "" ? undefined : filterNote],
				],
				...(events.length === 0
					? {
							empty: {
								message:
									filterNote === ""
										? "No distilled events for this session. It may predate event capture, or only have a visual (rrweb) recording."
										: `No distilled events for this session matching ${filterNote}.`,
								...(filterNote === ""
									? undefined
									: { hints: ["Drop only_errors, event_types or around_trace_id."] }),
							},
						}
					: undefined),
				blocks: events.length === 0 ? [] : [doc.code("text", events.map(formatLine).join("\n"))],
				...(pagination.nextOffset === undefined
					? undefined
					: {
							truncation: {
								shown: events.length,
								noun: "events",
								next: doc.next(
									"get_session_transcript",
									{
										session_id: output.sessionId,
										...(filters.eventTypes.length > 0
											? { event_types: filters.eventTypes }
											: undefined),
										only_errors: filters.onlyErrors ? true : undefined,
										around_trace_id: filters.aroundTraceId,
										limit: pagination.limit,
										offset: pagination.nextOffset,
									},
									"next page",
								),
							},
						}),
				next: traces.map((id) =>
					doc.next(
						"inspect_trace",
						{ trace_id: id },
						"backend trace for a request in this session",
					),
				),
			}
		},
	})
}
