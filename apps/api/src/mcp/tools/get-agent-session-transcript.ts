import {
	optionalBooleanParam,
	optionalNumberParam,
	optionalStringParam,
	requiredStringParam,
	validationError,
	type McpToolRegistrar,
} from "./types"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { clampLimit } from "@/mcp/lib/limits"
import { formatDurationFromMs, truncate } from "@/mcp/lib/format"
import { formatNextSteps } from "@/mcp/lib/next-steps"
import { createDualContent } from "@/mcp/lib/structured-output"
import {
	agentSessionWarehouseHandlers,
	clipPayload,
	loadAgentSessionSpans,
	offsetLabel,
	SESSION_TOO_LARGE,
	sessionTooLargeResult,
	sessionWindowOf,
	sessionWindowParams,
	windowHint,
} from "@/mcp/lib/agent-sessions"
import { Effect, Schema } from "effect"
import {
	buildSessionTurns,
	buildTranscript,
	sessionToolResults,
	turnOrdinal,
	type SessionTurn,
	type TranscriptPayload,
	type TranscriptRow,
} from "@maple/agent-sessions"

/** Text the answer will carry, before the next-step hints. A session that runs
 *  past it is cut at a turn boundary and says where to continue. */
const TRANSCRIPT_CHAR_BUDGET = 60_000

/** `4`, `4-9`, `4-` (from there on) — 1-based, as the turn headers print. */
const TURN_RANGE_PATTERN = /^(\d+)(?:-(\d+)?)?$/

interface TurnRange {
	readonly from: number
	readonly to: number | undefined
}

const parseTurnRange = (raw: string): TurnRange | undefined => {
	const match = TURN_RANGE_PATTERN.exec(raw.trim())
	if (match === null) return undefined
	const from = Number(match[1])
	if (from < 1) return undefined
	const to = match[2] === undefined ? (raw.includes("-") ? undefined : from) : Number(match[2])
	if (to !== undefined && to < from) return undefined
	return { from, to }
}

const payloadText = (payload: TranscriptPayload | undefined, chars: number): string => {
	if (payload === undefined) return "—"
	const text = clipPayload(payload.text, chars)
	return payload.truncatedByEmitter ? `${text} [cut off by the emitter]` : text
}

/** One transcript row as a line, indented by its lane depth. */
const renderRow = (row: TranscriptRow, sessionStartMs: number, payloadChars: number): string => {
	const indent = "  ".repeat(row.depth)
	const at =
		"startMs" in row && row.startMs !== undefined ? `${offsetLabel(row.startMs - sessionStartMs)} ` : ""
	const body = ((): string => {
		switch (row.kind) {
			case "turn":
				return `${turnOrdinal(row.turn)} — ${row.turn.agentName ?? "agent"} · ${row.llmCalls} llm · ${
					row.toolCalls
				} tool${row.toolNames.length > 0 ? ` (${row.toolNames.join(", ")})` : ""}${
					row.turn.failed ? " · FAILED" : ""
				}`
			case "empty-turn":
				return `${turnOrdinal(row.turn)} — no agent activity captured`
			case "user":
				return `[user]${row.earlierCount > 0 ? ` (${row.earlierCount} earlier messages re-sent)` : ""} ${clipPayload(row.text, payloadChars)}`
			case "system":
				return `[system] (sent on ${row.callCount} of ${row.turnCallCount} calls) ${clipPayload(row.text, payloadChars)}`
			case "assistant":
				return `[assistant]${row.failed ? " FAILED" : ""} ${
					row.text === undefined ? "(no output captured)" : clipPayload(row.text, payloadChars)
				}`
			case "prompt":
				return `[prompt] (no reply captured) ${clipPayload(row.text, payloadChars)}`
			case "thinking":
				return `[thinking] ${
					row.redacted ? "(redacted by the provider)" : clipPayload(row.text ?? "", payloadChars)
				}`
			case "tool":
				return `[tool ${row.toolName ?? "?"}]${row.failed ? " FAILED" : ""} ${payloadText(
					row.args,
					payloadChars,
				)} → ${payloadText(row.result, payloadChars)}`
			case "lane-open":
				return `▶ ${row.laneKind} ${row.agentName} opens${
					row.parentAgentName === undefined ? "" : ` (from ${row.parentAgentName})`
				} · ${row.spanCount} spans${row.args === undefined ? "" : ` · ${payloadText(row.args, payloadChars)}`}`
			case "lane-close":
				return `◀ ${row.laneKind} ${row.agentName} closes · ${formatDurationFromMs(row.durationMs)} · ${
					row.llmCalls
				} llm · ${row.toolCalls} tool${
					row.result === undefined ? "" : ` → ${payloadText(row.result, payloadChars)}`
				}`
			case "parallel":
				return `∥ ${row.lanes.length} lanes ran at once: ${row.lanes
					.map((lane) => lane.agentName)
					.join(", ")}`
			case "parallel-turns":
				return `∥ ${row.turns.length} turns ran at once: ${row.turns
					.map((entry) => turnOrdinal(entry.turn))
					.join(", ")}`
			case "structure":
				return `· ${row.label}${row.failed ? " FAILED" : ""} (no content captured)`
			case "note":
				return row.noteKind === "capture-off"
					? `— ${row.scope === "session" ? "This session" : "This turn"} captured ${
							row.anyCaptured ? "only some" : "no"
						} message content`
					: `— ${row.serviceName ?? "a service"} captures ${row.captures} of each call`
			case "divider":
				return row.dividerKind === "compaction"
					? `… the conversation was compacted here`
					: `… more of this session was not loaded`
		}
	})()
	return `${indent}${at}${body}`
}

interface RenderedRow {
	readonly row: TranscriptRow
	readonly line: string
}

/** Rows grouped by the turn they belong to, so the budget cuts on a boundary. */
interface TurnChunk {
	readonly turnIndex: number
	readonly rendered: RenderedRow[]
}

const chunkByTurn = (rendered: readonly RenderedRow[], firstTurnIndex: number): TurnChunk[] => {
	const chunks: TurnChunk[] = [{ turnIndex: firstTurnIndex, rendered: [] }]
	for (const entry of rendered) {
		if (entry.row.kind === "turn" || entry.row.kind === "empty-turn") {
			chunks.push({ turnIndex: entry.row.turn.index, rendered: [] })
		}
		chunks[chunks.length - 1].rendered.push(entry)
	}
	return chunks.filter((chunk) => chunk.rendered.length > 0)
}

export function registerGetAgentSessionTranscriptTool(server: McpToolRegistrar) {
	server.tool(
		"get_agent_session_transcript",
		"Read an AI agent session (an LLM agent trace, not a browser session replay) as a text transcript: turn headers, user and system messages, assistant replies, tool calls with their arguments and results, and sub-agent lanes, in order. Use after `get_agent_session` to see what was actually said. Long sessions are cut at a turn boundary — continue with `turns`. Drill into one span with `inspect_agent_session_span`.",
		Schema.Struct({
			session_id: requiredStringParam("The agent session id, from `list_agent_sessions`"),
			...sessionWindowParams,
			turns: optionalStringParam(
				'Turns to render, 1-based: "4" for one, "4-9" for a range, "4-" from there on. Omit for the whole session.',
			),
			include_thinking: optionalBooleanParam("Include the model's reasoning blocks (default false)"),
			payload_chars: optionalNumberParam(
				"Characters of each message, tool argument and tool result to show (default 600, max 5000)",
			),
		}),
		Effect.fn("McpTool.getAgentSessionTranscript")(function* (params) {
			const windowInput = sessionWindowOf(params)
			if (windowInput._tag === "invalid") return windowInput.result

			const range = params.turns === undefined ? undefined : parseTurnRange(params.turns)
			if (params.turns !== undefined && range === undefined) {
				return validationError(
					`Invalid turns: ${params.turns}. Expected a 1-based turn number ("4"), a range ("4-9"), or an open range ("4-").`,
				)
			}
			const payloadChars = clampLimit(params.payload_chars, { defaultValue: 600, max: 5_000 })

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				sessionId: params.session_id,
				turns: params.turns ?? "all",
			})

			// `ai` scope: the vendor-stamped spans are the transcript's whole input,
			// and the app's own HTTP/DB spans have nothing to say in it.
			const loaded = yield* loadAgentSessionSpans(tenant, {
				sessionId: params.session_id,
				window: windowInput.window,
				scope: "ai",
			}).pipe(
				Effect.catchTag("@maple/http/ai-sessions/AiSessionTooLargeError", () =>
					Effect.succeed(SESSION_TOO_LARGE),
				),
				Effect.catchTags(agentSessionWarehouseHandlers("get_agent_session_transcript")),
			)
			if (loaded === SESSION_TOO_LARGE) return sessionTooLargeResult(params.session_id)

			if (loaded.spans.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No agent spans for session ${params.session_id}${
								windowInput.window === undefined ? "" : " in the given window"
							}. Check the id with \`list_agent_sessions\`, or read every span with \`list_agent_session_spans scope="all"\`.`,
						},
					],
				}
			}

			const allTurns = buildSessionTurns(loaded.spans)
			const selected: readonly SessionTurn[] =
				range === undefined
					? allTurns
					: allTurns.filter(
							(turn) =>
								turn.index >= range.from &&
								(range.to === undefined || turn.index <= range.to),
						)
			if (selected.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Session ${params.session_id} has ${allTurns.length} turns; turns=${params.turns} selects none.`,
						},
					],
				}
			}

			const rows = buildTranscript({
				turns: selected,
				toolResults: sessionToolResults(loaded.spans),
				query: "",
				showThinking: params.include_thinking ?? false,
				hasMore: loaded.truncated,
				collapsedTurns: new Set(),
			})

			// Offsets are from the session's own start, so a later page's numbers
			// line up with an earlier one's.
			const sessionStartMs = allTurns[0].startMs
			const chunks = chunkByTurn(
				rows.map((row) => ({ row, line: renderRow(row, sessionStartMs, payloadChars) })),
				selected[0].index,
			)

			const emitted: RenderedRow[] = []
			let used = 0
			let continueFrom: number | undefined
			for (const chunk of chunks) {
				const size = chunk.rendered.reduce((total, entry) => total + entry.line.length + 1, 0)
				if (used > 0 && used + size > TRANSCRIPT_CHAR_BUDGET) {
					continueFrom = chunk.turnIndex
					break
				}
				emitted.push(...chunk.rendered)
				used += size
			}

			const lastTurn = selected[selected.length - 1]
			const lines: string[] = [
				`## Transcript — AI agent session ${params.session_id}`,
				`Turns ${selected[0].index}–${continueFrom === undefined ? lastTurn.index : continueFrom - 1} of ${allTurns.length} · ${loaded.spans.length} agent spans${
					params.include_thinking === true
						? ""
						: " · reasoning blocks hidden (include_thinking=true)"
				}`,
				...(loaded.truncated
					? [`The END of this session was not loaded — what follows is its beginning.`]
					: []),
				``,
				...emitted.map((entry) => entry.line),
			]

			const hint = loaded.window === undefined ? "" : ` ${windowHint(loaded.window)}`
			const nextSteps: string[] = []
			if (continueFrom !== undefined) {
				nextSteps.push(
					`\`get_agent_session_transcript session_id="${params.session_id}"${hint} turns="${continueFrom}-"\` — the rest of the session, from turn ${continueFrom}`,
				)
			}
			nextSteps.push(
				`\`list_agent_session_spans session_id="${params.session_id}"${hint}\` — every span with its ids and timings`,
			)
			lines.push(formatNextSteps(nextSteps))

			return {
				content: createDualContent(lines.join("\n"), {
					tool: "get_agent_session_transcript",
					data: {
						sessionId: params.session_id,
						turnCount: allTurns.length,
						firstTurn: selected[0].index,
						lastTurn: continueFrom === undefined ? lastTurn.index : continueFrom - 1,
						continueFromTurn: continueFrom ?? null,
						sessionTruncated: loaded.truncated,
						rows: emitted.map((entry) => ({
							kind: entry.row.kind,
							depth: entry.row.depth,
							text: truncate(entry.line.trim(), 2_000),
						})),
					},
				}),
			}
		}),
	)
}
