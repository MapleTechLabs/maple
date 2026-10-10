import { Effect, Option, Schema } from "effect"
import { warehouseDateTimeToIso } from "@maple/query-engine"
import {
	buildSessionTurns,
	buildTranscript,
	callMetaLine,
	failureDetailText,
	isLlmCall,
	sessionToolResults,
	spanFailed,
	type SessionTurn,
	type TranscriptPayload,
	type TranscriptRow,
} from "@maple/agent-sessions"
import type { AiSessionSpan } from "@maple/domain/http"
import { AgentTranscriptRow, GetAgentSessionTranscriptOutput } from "@maple/domain/mcp-outputs"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { formatDurationFromMs, tableCell, truncate } from "../lib/format"
import {
	clipPayload,
	loadAgentSessionSpans,
	loadSummary,
	offsetLabel,
	sessionTooLarge,
	sessionWindowFrom,
	sessionWindowParams,
	truncationNote,
} from "../lib/agent-sessions"
import { boundedText } from "../lib/agent-tool-analytics"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc, type DocBlock, type NextCall, type ToolDoc } from "../lib/tool-doc"

/** The loader keeps 1000 characters of a tool payload and 500 of a message; past that there is
 *  nothing to show, so the ceiling is the loader's. */
const PAYLOAD_CHARS_MAX = 1_000
/** A system prompt is context, not the conversation: one line of it is enough to recognise it. */
const SYSTEM_CHARS = 200
const SEARCH_MAX_CHARS = 200
/** Characters of rendered steps one page carries. The response budget clips past it and the
 *  clipped rows would never be paged to, so a page ends here and says where the next begins. */
const PAGE_CHARS = 14_000

type Output = typeof GetAgentSessionTranscriptOutput.Type
type Row = typeof AgentTranscriptRow.Type

const WHOLE_SESSION_TOO_LARGE =
	"Read part of it instead: pass a start_time/end_time narrower than the session's own bounds."

/** A tool result Maple's own tools wrap as `{"result": "..."}`, read as the text inside. */
const decodeWrapped = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Struct({ result: Schema.String })),
)
const unwrapResult = (text: string): string =>
	text.trimStart().startsWith('{"result"')
		? Option.getOrElse(decodeWrapped(text), () => ({ result: text })).result
		: text

const payloadText = (payload: TranscriptPayload | undefined, chars: number): string | undefined => {
	if (payload === undefined) return undefined
	if (payload.text === "")
		return payload.truncatedByEmitter ? "(cut by the emitter before capture)" : undefined
	const text = clipPayload(unwrapResult(payload.text).replace(/\s+/g, " ").trim(), chars)
	return payload.truncatedByEmitter ? `${text} (cut by the emitter)` : text
}

const clip = (text: string, chars: number): string => clipPayload(text.replace(/\s+/g, " ").trim(), chars)

/** The span fields every span row carries. */
const spanFields = (span: AiSessionSpan, startMs: number, sessionStartMs: number) => ({
	offsetMs: Math.max(0, startMs - sessionStartMs),
	spanId: span.spanId,
	traceId: span.traceId,
	timestamp: warehouseDateTimeToIso(span.timestamp),
})

/** Why a failed turn ended: its agent run's own failure, else the last failure inside it. */
function stopReason(turn: SessionTurn): string | undefined {
	if (!turn.failed) return undefined
	const anchor = turn.anchor
	if (spanFailed(anchor)) return failureDetailText(anchor) ?? (anchor.statusMessage || undefined)
	const last = turn.spans.findLast((span) => span.isAiSpan && spanFailed(span))
	return last === undefined ? undefined : failureDetailText(last)
}

/**
 * A transcript row as the wire carries it, or nothing for a row only the page draws (thinking,
 * an empty turn's placeholder). `turn` is the turn the row belongs to.
 */
function toRow(
	row: TranscriptRow,
	turn: number,
	sessionStartMs: number,
	payloadChars: number,
): Row | undefined {
	const base = { depth: row.depth, turn }
	switch (row.kind) {
		case "turn":
			return {
				...base,
				kind: "turn",
				...spanFields(row.turn.anchor, row.turn.startMs, sessionStartMs),
				durationMs: row.turn.durationMs,
				...(row.turn.agentName === undefined ? undefined : { agentName: row.turn.agentName }),
				...(row.turn.label === undefined ? undefined : { text: row.turn.label }),
				failed: row.turn.failed,
				...(stopReason(row.turn) === undefined ? undefined : { reason: stopReason(row.turn) }),
				llmCalls: row.llmCalls,
				toolCalls: row.toolCalls,
			}
		case "user":
			return {
				...base,
				kind: "user",
				...spanFields(row.span, row.startMs, sessionStartMs),
				text: clip(row.text, payloadChars),
			}
		case "system":
			return {
				...base,
				kind: "system",
				...spanFields(row.span, row.startMs, sessionStartMs),
				text: clip(row.text, Math.min(SYSTEM_CHARS, payloadChars)),
				meta: `sent with ${row.callCount} of ${row.turnCallCount} model calls`,
			}
		case "assistant": {
			const failure = row.failed ? failureDetailText(row.span) : undefined
			const text = row.text ?? failure
			return {
				...base,
				kind: "assistant",
				...spanFields(row.span, row.startMs, sessionStartMs),
				...(text === undefined ? undefined : { text: clip(text, payloadChars) }),
				meta: callMetaLine(row.span),
				failed: row.failed,
				...(row.toolCallsOnly
					? { result: "(called tools)" }
					: text === undefined
						? { result: "(reply not captured)" }
						: undefined),
			}
		}
		case "prompt":
			return {
				...base,
				kind: "prompt",
				...spanFields(row.span, row.startMs, sessionStartMs),
				text: clip(row.text, payloadChars),
				meta: callMetaLine(row.span),
			}
		case "tool": {
			const args = payloadText(row.args, payloadChars)
			const result =
				payloadText(row.result, payloadChars) ??
				(row.failed ? failureDetailText(row.span) : undefined)
			return {
				...base,
				kind: "tool",
				...spanFields(row.span, row.startMs, sessionStartMs),
				...(row.fromMessageOnly ? undefined : { durationMs: row.span.durationMs }),
				...(row.toolName === undefined ? undefined : { toolName: row.toolName }),
				...(args === undefined ? undefined : { args }),
				...(result === undefined ? undefined : { result }),
				failed: row.failed,
			}
		}
		case "lane-open": {
			const args = payloadText(row.args, payloadChars)
			return {
				...base,
				kind: "lane-open",
				...spanFields(row.span, row.startMs, sessionStartMs),
				agentName: row.agentName,
				meta:
					row.parentAgentName === undefined
						? row.laneKind
						: `${row.laneKind} of ${row.parentAgentName}`,
				...(args === undefined ? undefined : { args }),
			}
		}
		case "lane-close": {
			const result = payloadText(row.result, payloadChars)
			return {
				...base,
				kind: "lane-close",
				agentName: row.agentName,
				durationMs: row.durationMs,
				llmCalls: row.llmCalls,
				toolCalls: row.toolCalls,
				...(result === undefined ? undefined : { result }),
			}
		}
		case "parallel":
			return {
				...base,
				kind: "parallel",
				offsetMs: Math.max(0, row.startMs - sessionStartMs),
				durationMs: row.endMs - row.startMs,
				lanes: row.lanes.map((lane) => lane.agentName),
			}
		case "parallel-turns": {
			// The run that encloses the cluster is the parent of the others, not one of them.
			const lanes = row.turns.filter(
				(ref) =>
					!(ref.turn.startMs <= row.startMs && ref.turn.endMs >= row.endMs && row.turns.length > 2),
			)
			if (lanes.length < 2) return undefined
			return {
				...base,
				kind: "parallel",
				offsetMs: Math.max(0, row.startMs - sessionStartMs),
				durationMs: row.endMs - row.startMs,
				lanes: lanes.map(
					(ref) => `turn ${ref.turn.index}${ref.turn.agentName ? ` (${ref.turn.agentName})` : ""}`,
				),
			}
		}
		case "structure":
			return {
				...base,
				kind: "structure",
				...spanFields(row.span, row.startMs, sessionStartMs),
				durationMs: row.span.durationMs,
				meta: row.label,
				failed: row.failed,
				...(row.failed ? { text: failureDetailText(row.span) } : undefined),
			}
		case "note":
			return {
				...base,
				kind: "note",
				text:
					row.noteKind === "capture-off"
						? row.scope === "session"
							? row.anyCaptured
								? "Most model calls in this session captured no messages; rows below show only what was captured."
								: "No model call in this session captured its messages: only the structure of the calls is known."
							: "No model call in this turn captured its messages."
						: `${row.serviceName ?? "A service"} captures ${row.captures === "none" ? "no" : row.captures === "both" ? "both halves of its" : `only the ${row.captures} of its`} model calls.`,
			}
		case "divider":
			return {
				...base,
				kind: "note",
				text:
					row.dividerKind === "more"
						? "The session continues past the spans read."
						: "The history was compacted here; later calls no longer carry what came before.",
			}
		case "empty-turn":
		case "thinking":
			return undefined
	}
}

/** The turn each row belongs to, in one pass: the nearest turn header at or above it. A
 *  parallel-turns marker precedes the turns it names, so it takes the first of them. */
function turnsOfRows(
	rows: ReadonlyArray<TranscriptRow>,
	selected: ReadonlyArray<SessionTurn>,
): ReadonlyArray<number> {
	const fallback = selected[0]?.index ?? 1
	return rows.reduce<{ readonly current: number; readonly turns: Array<number> }>(
		(acc, row) => {
			const current = row.kind === "turn" || row.kind === "empty-turn" ? row.turn.index : acc.current
			acc.turns.push(row.kind === "parallel-turns" ? (row.turns[0]?.turn.index ?? current) : current)
			return { current, turns: acc.turns }
		},
		{ current: fallback, turns: [] },
	).turns
}

/** Rows that matter to a failure read: every failed row, under the header of its turn. */
function failedOnly(rows: ReadonlyArray<Row>): ReadonlyArray<Row> {
	const failedTurns = new Set(rows.filter((row) => row.failed === true).map((row) => row.turn))
	return rows.filter((row) => (row.kind === "turn" ? failedTurns.has(row.turn) : row.failed === true))
}

/** When a run stopped, from the session's start: the end of its turn. */
const stoppedAtMs = (row: Row): number => (row.offsetMs ?? 0) + (row.durationMs ?? 0)

/** Failures across every turn in the order they happened, a stopped run at the moment it
 *  stopped: one failure that cascades through a fan-out reads as a sequence, not as a
 *  section per sub-agent. */
export function failureTimeline(rows: ReadonlyArray<Row>): ReadonlyArray<Row> {
	const at = failedAtMs
	return (
		rows
			.filter((row) => row.kind !== "turn" || row.failed === true)
			.map((row) => ({ ...row, depth: 0 }))
			// On a tie a run's stop follows the steps that stopped it.
			.toSorted((a, b) => at(a) - at(b) || Number(a.kind === "turn") - Number(b.kind === "turn"))
	)
}

/** When a row failed, from the session's start: a step when it started, a run when it stopped. */
const failedAtMs = (row: Row): number => (row.kind === "turn" ? stoppedAtMs(row) : (row.offsetMs ?? 0))

/** The selection's earliest failure in time, across every page: the span a reader opens first. */
export function earliestFailure(rows: ReadonlyArray<Row>): Output["firstFailure"] {
	const first = rows
		.filter((row) => row.failed === true)
		.reduce<Row | undefined>(
			(earliest, row) =>
				earliest === undefined || failedAtMs(row) < failedAtMs(earliest) ? row : earliest,
			undefined,
		)
	return first?.spanId === undefined || first.traceId === undefined || first.timestamp === undefined
		? undefined
		: { traceId: first.traceId, spanId: first.spanId, timestamp: first.timestamp }
}

/** Rows whose text mentions `needle`, under the header of their turn. A header that matches
 *  (its prompt, its stop reason) keeps its turn's header alone. */
function searchRows(rows: ReadonlyArray<Row>, needle: string): ReadonlyArray<Row> {
	const lower = needle.toLowerCase()
	const hit = (row: Row) =>
		[row.text, row.reason, row.meta, row.toolName, row.args, row.result, row.agentName].some(
			(value) => value !== undefined && value.toLowerCase().includes(lower),
		)
	const turnsWithHits = new Set(rows.filter(hit).map((row) => row.turn))
	return rows.filter((row) => (row.kind === "turn" ? turnsWithHits.has(row.turn) : hit(row)))
}

/** The rows of one page: up to `limit`, and no more than {@link PAGE_CHARS} of rendered text, but
 *  always at least one so a page never stalls. */
function pageRows(rows: ReadonlyArray<Row>, offset: number, limit: number): ReadonlyArray<Row> {
	const candidates = rows.slice(offset, offset + limit)
	const sizes = candidates.map((row) => (row.kind === "turn" ? 120 : rowLine(row).length + 1))
	const running = sizes.reduce<ReadonlyArray<number>>((acc, size) => [...acc, (acc.at(-1) ?? 0) + size], [])
	return candidates.slice(0, Math.max(1, running.filter((total) => total <= PAGE_CHARS).length))
}

/** Characters of shared opening below which stripping it would leave too little context. */
const SHARED_OPENING_MIN = 20

/** The longest prefix every text shares, cut back to a word boundary. */
function sharedPrefix(texts: ReadonlyArray<string>): string {
	const [first = "", ...rest] = texts
	const length = rest.reduce((shared, text) => {
		const limit = Math.min(shared, text.length)
		const differsAt = Array.from({ length: limit }, (_, i) => i).find((i) => text[i] !== first[i])
		return differsAt ?? limit
	}, first.length)
	const cut = first.slice(0, length)
	return cut.slice(0, Math.max(0, cut.lastIndexOf(" ") + 1))
}

/**
 * Each turn's opening as told apart from its siblings: sub-agents of one fan-out open with
 * the same brief and differ further in (the files each was handed), so the part an agent's
 * turns share is dropped and the rest leads. Read from the full first prompt where one was
 * captured; a turn label is cut to one line and would make every sibling look the same.
 */
export function distinguishingOpenings(
	turns: ReadonlyArray<Output["turns"][number]>,
	rows: ReadonlyArray<Row>,
): ReadonlyMap<number, string> {
	const openings = turns.flatMap((turn) => {
		const prompt = rows.find((row) => row.turn === turn.turn && row.kind === "user")?.text
		const text = (prompt ?? turn.label)?.replace(/… \(\d+ bytes total\)$/, "…")
		return text === undefined ? [] : [{ turn: turn.turn, agent: turn.agentName ?? "", text }]
	})
	return new Map(
		openings.map((opening) => {
			const siblings = openings.filter((sibling) => sibling.agent === opening.agent)
			const shared = siblings.length > 1 ? sharedPrefix(siblings.map((sibling) => sibling.text)) : ""
			const rest = opening.text.slice(shared.length).trim()
			return [
				opening.turn,
				shared.length >= SHARED_OPENING_MIN && rest !== "" ? `…${rest}` : opening.text,
			] as const
		}),
	)
}

const turnSummary = (turn: SessionTurn, sessionStartMs: number): Output["turns"][number] => ({
	turn: turn.index,
	anchorKind: turn.anchorKind,
	...(turn.agentName === undefined ? undefined : { agentName: turn.agentName }),
	offsetMs: Math.max(0, turn.startMs - sessionStartMs),
	durationMs: turn.durationMs,
	failed: turn.failed,
	...(turn.label === undefined ? undefined : { label: turn.label }),
	...(stopReason(turn) === undefined ? undefined : { stopReason: stopReason(turn) }),
})

export function registerGetAgentSessionTranscriptTool(server: McpToolRegistrar) {
	server.define({
		name: "get_agent_session_transcript",
		title: "Get Agent Session Transcript",
		description:
			"Read what an AI agent session did, step by step: each turn's prompt, the model's replies, every tool call with its arguments and result, sub-agent runs and what they returned, and what failed. `get_agent_session` is the verdict; this is the record behind it. Narrow with `turn` (one turn or sub-agent run), `failed_only`, or `search`; page with `offset`. Each step names its span, which `inspect_span` opens in full. Not browser session replays: those are `get_session_transcript`.",
		parameters: Schema.Struct({
			session_id: P.text(
				"The agent session id, as `list_agent_sessions` reports it (a vendor id, or `trace:<traceId>`)",
			).check(Schema.isMinLength(1)),
			...sessionWindowParams,
			turn: P.optionalNumber(
				"Only this turn (1-based, as the result's turn index lists them). A sub-agent run is a turn of its own",
			),
			failed_only: P.optionalFlag(
				"Only the steps that failed. Without `turn`: every failure in the session in time order, a stopped sub-agent at the moment it stopped (where a cascade starts). With `turn`: that turn's failures",
			),
			search: boundedText(
				"Only steps whose text contains this (case-insensitive): a message, a tool name, its arguments or result",
				SEARCH_MAX_CHARS,
			),
			payload_chars: P.limit({
				default: 300,
				max: PAYLOAD_CHARS_MAX,
				description: "Characters kept of each message, argument and result",
			}),
			limit: P.limit({ default: 120, max: 500, noun: "steps" }),
			offset: P.offset({ max: 50_000 }),
		}),
		output: GetAgentSessionTranscriptOutput,
		hints: { readOnly: true },
		phrases: ["Reading an agent session"],
		handler: Effect.fn("McpTool.getAgentSessionTranscript")(
			function* (params) {
				const sessionId = params.session_id
				const window = yield* sessionWindowFrom(params)
				const { limit, offset, payload_chars: payloadChars } = params
				const search = params.search?.trim() === "" ? undefined : params.search?.trim()

				const tenant = yield* CurrentMcpTenant
				yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.ai.session.id": sessionId })

				const loaded = yield* loadAgentSessionSpans(tenant, { sessionId, window })
				yield* Effect.annotateCurrentSpan("result.rowCount", loaded.spans.length)
				if (loaded.spans.length === 0) {
					return yield* new McpInvalidInputError({
						message: `No spans for AI agent session ${sessionId}${
							window === undefined
								? '. Check the id: `list_agent_sessions search="<prefix>"` finds it.'
								: " in the given window. Drop start_time/end_time to resolve the session's own bounds, or check the id with `list_agent_sessions`."
						}`,
						parameter: "session_id",
					})
				}

				const turns = buildSessionTurns(loaded.spans)
				const sessionStartMs = Math.min(...turns.map((turn) => turn.startMs))
				const turnIndex = turns.map((turn) => turnSummary(turn, sessionStartMs))

				const wanted = params.turn
				const selected = wanted === undefined ? turns : turns.filter((turn) => turn.index === wanted)
				if (selected.length === 0) {
					return yield* new McpInvalidInputError({
						message: `Invalid turn: ${wanted}. This session has ${turns.length} turn${turns.length === 1 ? "" : "s"}, numbered 1 to ${turns.length}.`,
						parameter: "turn",
					})
				}

				const spans = loaded.spans
				const transcript = buildTranscript({
					turns: selected,
					toolResults: sessionToolResults(spans),
					// Searched below, over the rows as they are read, stop reasons included.
					query: "",
					showThinking: false,
					hasMore: loaded.truncated !== false,
					collapsedTurns: new Set(),
				})

				const rowTurns = turnsOfRows(transcript, selected)
				const allRows = transcript.flatMap((row, index) => {
					const mapped = toRow(row, rowTurns[index] ?? 1, sessionStartMs, payloadChars)
					return mapped === undefined ? [] : [mapped]
				})
				const searched = search === undefined ? allRows : searchRows(allRows, search)
				const rows =
					params.failed_only !== true
						? searched
						: wanted === undefined
							? failureTimeline(failedOnly(searched))
							: failedOnly(searched)
				const openings =
					wanted === undefined
						? distinguishingOpenings(turnIndex, allRows)
						: new Map<number, string>()
				const page = pageRows(rows, offset, limit)
				const firstFailure = earliestFailure(rows)
				const hasMore = offset + page.length < rows.length

				const llmSpans = selected.flatMap((turn) => turn.spans).filter(isLlmCall)
				const capturedCalls = llmSpans.filter(
					(span) =>
						// A `null` an emitter wrote decodes as `null`, not a missing key, and captured nothing.
						(span.genAi.inputMessages ?? undefined) !== undefined ||
						(span.genAi.outputMessages ?? undefined) !== undefined,
				).length

				const output: Output = {
					sessionId,
					...(loaded.window === undefined
						? undefined
						: { window: { start: loaded.window.startTime, end: loaded.window.endTime } }),
					load: loadSummary(loaded),
					turns: turnIndex.map((turn) => {
						const opening = openings.get(turn.turn)
						return opening === undefined ? turn : { ...turn, label: opening }
					}),
					selection: {
						...(params.turn === undefined ? undefined : { turn: params.turn }),
						...(params.failed_only === undefined
							? undefined
							: { failedOnly: params.failed_only }),
						...(search === undefined ? undefined : { search }),
						payloadChars,
					},
					rowCount: rows.length,
					rows: page,
					pagination: {
						offset,
						limit,
						hasMore,
						total: rows.length,
						...(hasMore ? { nextOffset: offset + page.length } : undefined),
					},
					capture: { capturedCalls, llmCalls: llmSpans.length },
					...(firstFailure === undefined ? undefined : { firstFailure }),
				}
				return output
			},
			Effect.catchTags(warehouseReadToMcpHandlers("get_agent_session_transcript")),
			Effect.catchTag(
				"@maple/http/ai-sessions/AiSessionTooLargeError",
				sessionTooLarge("get_agent_session_transcript", WHOLE_SESSION_TOO_LARGE),
			),
		),
		render: (output) => renderTranscript(output),
	})
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

const at = (row: Row): string => (row.offsetMs === undefined ? "" : `[${offsetLabel(row.offsetMs)}] `)
const indent = (row: Row): string => "  ".repeat(row.depth)
const spanRef = (row: Row): string => (row.spanId === undefined ? "" : ` · span ${row.spanId}`)
const oneLine = (text: string, chars = 2_000): string => tableCell(text, chars)

function rowLine(row: Row): string {
	const lead = `${indent(row)}${at(row)}`
	switch (row.kind) {
		case "turn":
			return ""
		case "user":
			return `${lead}user: ${oneLine(row.text ?? "")}`
		case "system":
			return `${lead}system (${row.meta}): ${oneLine(row.text ?? "")}`
		case "assistant": {
			const head = `${lead}assistant${row.failed === true ? " FAILED" : ""}${row.meta ? ` · ${row.meta}` : ""}`
			const body =
				row.text !== undefined
					? `: ${oneLine(row.text)}`
					: row.result !== undefined
						? ` ${row.result}`
						: ""
			return `${head}${body}${spanRef(row)}`
		}
		case "prompt":
			return `${lead}prompt (reply not captured)${row.meta ? ` · ${row.meta}` : ""}: ${oneLine(row.text ?? "")}${spanRef(row)}`
		case "tool": {
			const status = row.failed === true ? " FAILED" : ""
			const took = row.durationMs === undefined ? "" : ` (${formatDurationFromMs(row.durationMs)})`
			const args = row.args === undefined ? "" : ` args: ${oneLine(row.args)}`
			const result = row.result === undefined ? " → (no result captured)" : ` → ${oneLine(row.result)}`
			return `${lead}tool ${row.toolName ?? "?"}${status}${took}${args}${result}${spanRef(row)}`
		}
		case "lane-open":
			return `${lead}▶ ${row.meta ?? "lane"} ${row.agentName ?? ""}${row.args === undefined ? "" : ` asked: ${oneLine(row.args)}`}${spanRef(row)}`
		case "lane-close":
			return `${lead}◀ ${row.agentName ?? ""} finished after ${formatDurationFromMs(row.durationMs ?? 0)} · ${row.llmCalls ?? 0} model calls, ${row.toolCalls ?? 0} tool calls${row.result === undefined ? "" : ` → returned: ${oneLine(row.result)}`}`
		case "parallel":
			return `${lead}‖ ran in parallel: ${(row.lanes ?? []).join(", ")}`
		case "structure":
			return `${lead}${row.meta ?? "span"}${row.failed === true ? " FAILED" : ""} (no content captured)${row.text ? `: ${oneLine(row.text)}` : ""}${spanRef(row)}`
		case "note":
			return `${lead}(${row.text ?? ""})`
	}
}

function turnHeading(row: Row, turnCount: number): string {
	const parts = [
		`Turn ${row.turn} of ${turnCount}`,
		row.agentName,
		row.offsetMs === undefined
			? undefined
			: `${offsetLabel(row.offsetMs)} for ${formatDurationFromMs(row.durationMs ?? 0)}`,
		`${row.llmCalls ?? 0} model calls, ${row.toolCalls ?? 0} tool calls`,
		row.failed === true
			? `FAILED${row.reason === undefined ? "" : `: ${oneLine(row.reason, 200)}`}`
			: undefined,
	]
	return parts.filter((part) => part !== undefined && part !== "").join(" · ")
}

function renderTranscript(output: Output): ToolDoc {
	const blocks: DocBlock[] = []
	const note = truncationNote(output.load)
	if (note !== undefined) blocks.push(doc.text(note))

	// The turn index, so a caller can pick a turn without paging through the others.
	if (output.selection.turn === undefined && output.turns.length > 1 && output.pagination.offset === 0) {
		blocks.push(doc.heading(`Turns (${output.turns.length})`))
		// Sub-agents of one fan-out open with the same brief; the column only earns its width
		// when the openings tell the turns apart.
		const distinctLabels = new Set(output.turns.map((turn) => turn.label)).size > 1
		blocks.push(
			doc.table(
				["Turn", "Agent", "Start", "Duration", "Outcome", ...(distinctLabels ? ["Opened with"] : [])],
				output.turns.map((turn) => [
					String(turn.turn),
					turn.agentName ?? "—",
					offsetLabel(turn.offsetMs),
					formatDurationFromMs(turn.durationMs),
					turn.failed
						? `failed${turn.stopReason === undefined ? "" : `: ${truncate(turn.stopReason, 100)}`}`
						: "ok",
					...(distinctLabels ? [turn.label === undefined ? "—" : truncate(turn.label, 80)] : []),
				]),
			),
		)
	}

	const timeline = output.selection.failedOnly === true && output.selection.turn === undefined
	if (timeline && output.rows.length > 0) {
		blocks.push(doc.heading("Failures in time order"))
		blocks.push(
			doc.code(
				"text",
				output.rows
					.map((row) =>
						row.kind === "turn"
							? `[${offsetLabel(stoppedAtMs(row))}] turn ${row.turn}${row.agentName ? ` (${row.agentName})` : ""} stopped: ${oneLine(row.reason ?? "failed")}${spanRef(row)}`
							: `turn ${row.turn} · ${rowLine(row)}`,
					)
					.join("\n"),
			),
		)
	}

	// Each turn reads as a heading over one block of its steps.
	const sections = (timeline ? [] : output.rows).reduce<
		ReadonlyArray<{ readonly header?: Row; readonly lines: ReadonlyArray<string> }>
	>(
		(acc, row) =>
			row.kind === "turn"
				? [...acc, { header: row, lines: [] }]
				: acc.length === 0
					? [{ lines: [rowLine(row)] }]
					: [
							...acc.slice(0, -1),
							{ ...acc[acc.length - 1]!, lines: [...acc[acc.length - 1]!.lines, rowLine(row)] },
						],
		[],
	)
	// A page that starts inside a turn still says which turn it is in.
	const continued =
		timeline || output.pagination.offset === 0 || output.rows[0]?.kind === "turn"
			? undefined
			: output.rows[0]?.turn
	if (continued !== undefined)
		blocks.push(doc.heading(`Turn ${continued} of ${output.turns.length} (continued)`))
	for (const section of sections) {
		if (section.header !== undefined)
			blocks.push(doc.heading(turnHeading(section.header, output.turns.length)))
		if (section.lines.length > 0) blocks.push(doc.code("text", section.lines.join("\n")))
	}

	const traceIds = [
		...new Set(output.rows.flatMap((row) => (row.traceId === undefined ? [] : [row.traceId]))),
	]
	const firstFailed = output.firstFailure
	const windowArgs =
		output.window === undefined ? {} : { start_time: output.window.start, end_time: output.window.end }
	const selectionArgs = {
		...(output.selection.turn === undefined ? undefined : { turn: output.selection.turn }),
		...(output.selection.failedOnly === undefined
			? undefined
			: { failed_only: output.selection.failedOnly }),
		...(output.selection.search === undefined ? undefined : { search: output.selection.search }),
	}
	const next: NextCall[] = []
	if (firstFailed !== undefined) {
		next.push(
			doc.next(
				"inspect_span",
				{
					trace_id: firstFailed.traceId,
					span_id: firstFailed.spanId,
					timestamp: firstFailed.timestamp,
				},
				"the session's earliest failure in full",
			),
		)
	}
	if (output.selection.failedOnly !== true && output.rows.some((row) => row.failed === true)) {
		next.push(
			doc.next(
				"get_agent_session_transcript",
				{ session_id: output.sessionId, ...windowArgs, ...selectionArgs, failed_only: true },
				"only the steps that failed",
			),
		)
	}
	const selectedTurn = output.selection.turn
	if (selectedTurn !== undefined && selectedTurn < output.turns.length) {
		next.push(
			doc.next(
				"get_agent_session_transcript",
				{ session_id: output.sessionId, ...windowArgs, ...selectionArgs, turn: selectedTurn + 1 },
				"the next turn",
			),
		)
	}

	return {
		title: `AI agent session ${output.sessionId}: transcript`,
		scope: [
			[
				"Window",
				output.window === undefined ? undefined : `${output.window.start} to ${output.window.end}`,
			],
			["Turn", selectedTurn === undefined ? undefined : `${selectedTurn} of ${output.turns.length}`],
			["Only", output.selection.failedOnly === true ? "failed steps" : undefined],
			["Search", output.selection.search],
			["Trace", traceIds.length === 1 ? traceIds[0] : undefined],
		],
		...(output.rows.length === 0
			? {
					empty: {
						message:
							output.rowCount === 0 && output.selection.failedOnly === true
								? "No step failed in the selection."
								: output.rowCount === 0 && output.selection.search !== undefined
									? `No step mentions "${output.selection.search}".`
									: "No agent steps in the selection.",
						hints: ["Drop failed_only/search, or pick another turn from the index."],
					},
				}
			: undefined),
		blocks,
		...(output.pagination.nextOffset === undefined
			? undefined
			: {
					truncation: {
						shown: output.rows.length,
						total: output.rowCount,
						noun: "steps",
						next: doc.next(
							"get_agent_session_transcript",
							{
								session_id: output.sessionId,
								...windowArgs,
								...selectionArgs,
								payload_chars: output.selection.payloadChars,
								limit: output.pagination.limit,
								offset: output.pagination.nextOffset,
							},
							"next page",
						),
					},
				}),
		next,
	}
}
