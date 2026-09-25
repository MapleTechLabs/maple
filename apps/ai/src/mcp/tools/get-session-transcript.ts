import { Effect, Schema, SchemaTransformation } from "effect"
import { GetSessionTranscriptOutput, SessionTranscriptEventType } from "@maple/domain/mcp-outputs"
import { getSessionTranscript } from "@maple/query-engine/observability"
import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

type TranscriptEvent = (typeof GetSessionTranscriptOutput.Type.events)[number]
type TranscriptFilters = typeof GetSessionTranscriptOutput.Type.filters
type EventType = typeof SessionTranscriptEventType.Type

/**
 * The event types to keep, published as an array of the enum; a comma-separated string is still
 * accepted (trimmed, lowercased) because the parameter used to be one.
 */
const EventTypeList = Schema.Union([
	Schema.Array(SessionTranscriptEventType),
	Schema.String.pipe(
		Schema.decodeTo(
			Schema.Array(Schema.String),
			SchemaTransformation.transform<ReadonlyArray<string>, string>({
				decode: (value) =>
					value
						.split(",")
						.map((part) => part.trim().toLowerCase())
						.filter((part) => part !== ""),
				encode: (values) => values.join(","),
			}),
		),
		// The split parts are then held to the enum, so an unknown type is a parameter error.
		Schema.decodeTo(Schema.Array(SessionTranscriptEventType)),
	),
])

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
			"Read a browser session replay (session id from `search_sessions`; for an AI agent session use `get_agent_session`) as a text transcript: navigation, clicks, console logs, network requests and errors in order, each with the trace id it ran under. Use it to see what a user did and where it went wrong; `inspect_trace` opens any referenced trace.",
		parameters: Schema.Struct({
			session_id: P.text("The session id to read (from search_sessions)"),
			event_types: Schema.optional(EventTypeList).annotate({
				description: "Only these event types. Omit for all.",
			}),
			only_errors: P.optionalFlag(
				"Only what went wrong: error events, console errors and requests with status >= 400.",
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
			const types: ReadonlyArray<EventType> = [...new Set(params.event_types ?? [])]
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
			// A few distinct traces for drill-down, each with the timestamp `inspect_trace` prunes on.
			const traces = new Map<string, string>()
			for (const event of events) {
				if (event.traceId && !traces.has(event.traceId)) traces.set(event.traceId, event.timestamp)
				if (traces.size === 3) break
			}
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
				next: [...traces].map(([id, timestamp]) =>
					doc.next(
						"inspect_trace",
						{ trace_id: id, timestamp },
						"backend trace for a request in this session",
					),
				),
			}
		},
	})
}
