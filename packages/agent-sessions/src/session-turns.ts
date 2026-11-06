// Session structure: what a span is, and where one turn ends and the next begins.
//
// A session arrives as a flat list of spans drawn from several traces and
// services, and the detail page's whole value is recovering the shape of the
// conversation that produced them. No framework records "this is turn 4", so
// every rule below is a heuristic over the OTel gen_ai attributes — which is
// exactly why they live here, named and commented, instead of inside the
// components that render them.
//
// Timestamps are parsed as reported, without the clock-skew correction
// `span-tree.ts` applies inside a single trace, so a child that a skewed clock
// placed outside its parent can land in a neighbouring turn.

import {
	AI_AGENT_OPERATIONS,
	AI_INFERENCE_OPERATIONS,
	AI_MEMORY_OPERATIONS,
	AI_RETRIEVAL_OPERATIONS,
	AI_TOOL_OPERATIONS,
} from "@maple/domain/gen-ai"
import type { AiSessionSpan } from "@maple/domain/http"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { Array as Arr, Option, String as Str } from "effect"

/**
 * How a span reads on the page. Deliberately coarse — these four are the
 * distinctions the waterfall colors, the occupancy bar splits on, and the work
 * counters tally, and nothing else needs a finer taxonomy.
 */
export type AiSpanCategory = "agent" | "inference" | "tool" | "other"

/** Inference-shaped work that is not a chat completion: counted as inference
 *  occupancy, never as an "llm call" — an embedding is not a model turn. */
const RETRIEVAL_OPS: ReadonlySet<string> = new Set(AI_RETRIEVAL_OPERATIONS)
/** A memory-store operation is the agent's own bookkeeping, so it reads as agent
 *  work — not a model turn, not a tool call. */
const MEMORY_OPS: ReadonlySet<string> = new Set(AI_MEMORY_OPERATIONS)

/** Every operation name `@maple/domain/gen-ai` groups. A span name conventionally
 *  leads with one ("execute_tool read_file", "chat gpt-5"), so a view that wants
 *  to set the operation apart from its subject needs to know which words are
 *  operations — including for the reporters that skip `gen_ai.operation.name`. */
export const GEN_AI_OPERATIONS: ReadonlySet<string> = new Set([
	...AI_INFERENCE_OPERATIONS,
	...RETRIEVAL_OPS,
	...AI_TOOL_OPERATIONS,
	...AI_AGENT_OPERATIONS,
	...MEMORY_OPS,
])

export function spanStartMs(span: AiSessionSpan): number {
	return parseWarehouseDateTime(span.timestamp)
}

export function spanEndMs(span: AiSessionSpan): number {
	return spanStartMs(span) + span.durationMs
}

/**
 * The model the span ran on, falling back to the one it asked for. When the
 * response only resolved the request to a dated snapshot or dropped its
 * provider prefix, the requested name stands, so one model is one name
 * whether a call answered `gpt-4o-mini-2024-07-18`, `gpt-4o-mini` or failed
 * first. The ingest gateway stamps `maple_ai.model` by the same rule.
 */
export function spanModel(span: AiSessionSpan): string | undefined {
	const { responseModel, requestModel } = span.genAi
	if (responseModel !== undefined && requestModel !== undefined && sameModel(requestModel, responseModel)) {
		return requestModel
	}
	return responseModel ?? requestModel
}

const RELEASE_DATE = /-(?:\d{4}-\d{2}-\d{2}|\d{8})$/

/** `response` is `request` itself: compared without a provider prefix or the
 *  dots some providers spell as dashes, and, when the request names no
 *  release, without the release date the response resolved it to. A pinned
 *  request answered by another release is a different model. */
function sameModel(request: string, response: string): boolean {
	const base = (model: string) =>
		Str.toLowerCase(Str.replaceAll(".", "-")(Str.split("/")(model).at(-1) ?? model))
	const [asked, answered] = [base(request), base(response)]
	if (asked === answered) return true
	return !RELEASE_DATE.test(asked) && Str.replace(RELEASE_DATE, "")(answered) === asked
}

/**
 * How the span reads, by the ingest gateway's verdict (`MAPLE_AI_STAMP_ATTRS`),
 * the one the sessions list counts. A span it did not stamp is the app's own
 * HTTP/DB work sharing the agent's traces: rendered, muted, never colored as
 * agent work.
 */
export function classifyAiSpan(span: AiSessionSpan): AiSpanCategory {
	const { mapleLlmCall, mapleToolCall, operationName } = span.genAi
	if (mapleLlmCall === undefined) return "other"
	if (mapleLlmCall === 1) return "inference"
	// `0` is the copy a call paused for a human's approval left: still a tool
	// span on screen, never counted (`isCountedToolCall`).
	if (mapleToolCall !== undefined) return "tool"
	return operationName !== undefined && RETRIEVAL_OPS.has(operationName) ? "inference" : "agent"
}

/** A model turn — one request/response with a model, and what the header counts
 *  as an "llm call": the gateway's `maple_ai.llm_call = 1`. */
export function isLlmCall(span: AiSessionSpan): boolean {
	return span.genAi.mapleLlmCall === 1
}

/**
 * A tool call that counts, wherever tool calls are counted: the gateway's
 * `maple_ai.tool_call = 1`, which leaves out the copy a call paused for a
 * human's approval left although it renders as a tool.
 */
export function isCountedToolCall(span: AiSessionSpan): boolean {
	return span.genAi.mapleToolCall === 1
}

/**
 * Whether the span failed. On a span the ingest gateway stamped, its verdict
 * (`MAPLE_AI_STAMP_ATTRS.error`): span status, `error.type` or a failed
 * `gen_ai.response.status`, less the copy a call paused for a human's approval
 * leaves, which some frameworks end in error. Any other span by its status
 * alone: HTTP instrumentation stamps `error.type` on expected 4xx requests
 * whose status is deliberately not `Error`.
 */
export function spanFailed(span: AiSessionSpan): boolean {
	if (span.genAi.mapleLlmCall === undefined) return span.statusCode === "Error"
	return span.genAi.mapleError === 1
}

/** `gen_ai.response.time_to_first_chunk` is in SECONDS (see ai-vendors.ts). */
export function spanTtftMs(span: AiSessionSpan): number | undefined {
	const seconds = span.genAi.responseTimeToFirstChunk
	if (seconds === undefined || seconds <= 0) return undefined
	const ms = seconds * 1000
	// A TTFT longer than the span it belongs to is a unit mix-up somewhere
	// upstream; drawing it would push the streaming segment negative.
	return ms > span.durationMs ? undefined : ms
}

/** Which of the three rules below produced a turn boundary — the waterfall
 *  labels the turn by it. */
export type TurnAnchorKind = "conversation" | "agent-root" | "trace"

export interface SessionTurn {
	readonly id: string
	/** 1-based, in start order — the `TURN n` the page prints. */
	readonly index: number
	readonly anchorKind: TurnAnchorKind
	/** The span that opened the turn. */
	readonly anchor: AiSessionSpan
	/** The turn's newest user message, when the vendor captured message content. */
	readonly label: string | undefined
	readonly agentName: string | undefined
	readonly startMs: number
	readonly endMs: number
	readonly durationMs: number
	/** Every span of the turn, in start order. */
	readonly spans: readonly AiSessionSpan[]
	/** An AI span that roots the turn ended `Error` — the turn did not close cleanly. */
	readonly failed: boolean
	/** Traces the turn's spans came from, first-seen first. A turn may cross traces. */
	readonly traceIds: readonly string[]
}

const WORK_CATEGORIES: ReadonlySet<AiSpanCategory> = new Set(["inference", "tool"])
/** How soon before the next turn a workless anchor must end to be its setup:
 *  the pause the session summary starts calling idle. */
const SETUP_LEAD_MAX_MS = 5_000

interface TurnAnchor {
	readonly span: AiSessionSpan
	readonly kind: TurnAnchorKind
	readonly id: string
	/** The `gen_ai.conversation.id` this anchor owns, on the conversation rule
	 *  only. It is also how member spans find their way to this turn. */
	readonly conversationId: string | undefined
}

/**
 * Split a session's spans into turns.
 *
 * Three rules, tried in order, because there is no single attribute that marks
 * "the user said something new":
 *
 * 1. `gen_ai.conversation.id` — the only turn key the convention has, and the
 *    one eve stamps with its turn id. One id, one turn. `findAnchors` requires
 *    more than one distinct id, and ignores vendors that derive the session id
 *    from it. The ids may INTERLEAVE in time: Maple's investigation fan-out
 *    stamps one per hypothesis lane and launches the lanes together.
 * 2. Agent invocations with no agent above them — a session with no usable
 *    conversation id still opens each turn by invoking the agent.
 * 3. One turn per trace — the floor. Wrong for a trace holding several turns,
 *    but it never merges two traces into one turn, and it always renders.
 *
 * Assignment then depends on which rule fired. On rule 1 the id a span CARRIES
 * decides, because concurrent turns make time meaningless as an owner: a pure
 * time cursor gives each lane only the sliver before the next lane anchored and
 * dumps every lane's tail into whichever anchored last. On rule 2 the agent root
 * above a span decides, for the same reason: a fan-out starts its sub-agents
 * together. On rule 3, and for any span neither rule places, a turn owns every
 * span that started before the next turn did, whatever trace or service it came from. Spans that start before
 * the first anchor (a gateway span that opens the trace, say) join turn 1 rather
 * than becoming a turn of their own.
 */
export function buildSessionTurns(spans: readonly AiSessionSpan[]): readonly SessionTurn[] {
	if (spans.length === 0) return []

	// Decorate/sort/undecorate: one timestamp parse per span rather than one per
	// comparison.
	const ordered = Arr.map(spans, (span) => ({ span, startMs: spanStartMs(span) })).sort(
		(a, b) => a.startMs - b.startMs,
	)
	const anchors = findAnchors(Arr.map(ordered, (entry) => entry.span))
	const anchorStarts = Arr.map(anchors, (anchor) => spanStartMs(anchor.span))
	const buckets: AiSessionSpan[][] = Arr.map(anchors, () => [])
	const turnOf =
		anchors[0]?.kind === "agent-root"
			? agentRootTurnResolver(spans, anchors)
			: conversationTurnResolver(spans, anchors)

	// Both lists are in start order, so one forward cursor assigns every span that
	// names no turn of its own.
	let cursor = 0
	for (const { span, startMs } of ordered) {
		for (let following = anchorStarts[cursor + 1]; following !== undefined && following <= startMs;) {
			cursor++
			following = anchorStarts[cursor + 1]
		}
		buckets[turnOf(span) ?? cursor]?.push(span)
	}

	// On rules 2 and 3 the boundary is a guess, and an anchor that opened no
	// work — no model or tool call, no prompt, nothing failed — right before the
	// next turn is that turn's setup: Microsoft Agent Framework's one-span
	// `workflow.build` trace ahead of its `workflow.run` became an empty turn 1
	// that also took the session's title. Its spans join the next turn, as spans
	// before the first anchor join turn 1; the cursor filled the buckets in start
	// order, so they stay in it. One followed by a pause is left alone, and a
	// session with no work anywhere keeps its anchors.
	const opened = (bucket: readonly AiSessionSpan[]) =>
		Arr.some(
			bucket,
			(span) =>
				WORK_CATEGORIES.has(classifyAiSpan(span)) ||
				spanFailed(span) ||
				lastUserMessageText(span.genAi.inputMessages) !== undefined,
		)
	if (anchors[0]?.kind !== "conversation" && Arr.some(buckets, opened)) {
		for (let i = 0; i < buckets.length - 1; i++) {
			const bucket = buckets[i]
			const next = buckets[i + 1]
			if (bucket === undefined || next === undefined || opened(bucket)) continue
			const endMs = Arr.reduce(bucket, Number.NEGATIVE_INFINITY, (max, span) =>
				Math.max(max, spanEndMs(span)),
			)
			if (next[0] !== undefined && spanStartMs(next[0]) - endMs > SETUP_LEAD_MAX_MS) continue
			for (const span of next) bucket.push(span)
			buckets[i + 1] = bucket
			buckets[i] = []
		}
	}

	// A turn with no spans has no start, no end and nothing to draw. Rules 1 and 2
	// cannot produce one, since an anchor resolves to its own bucket even when
	// another shares its millisecond; two trace anchors in one millisecond still
	// leave the earlier bucket empty.
	return Arr.map(
		Arr.filter(
			Arr.map(anchors, (anchor, index) => ({ anchor, turnSpans: buckets[index] ?? [] })),
			(entry) => entry.turnSpans.length > 0,
		),
		({ anchor, turnSpans }, index) => {
			const spanIds = new Set(Arr.map(turnSpans, (span) => span.spanId))
			const startMs = Math.min(...Arr.map(turnSpans, spanStartMs))
			const endMs = Math.max(...Arr.map(turnSpans, spanEndMs))
			const traceIds: string[] = []
			for (const span of turnSpans) if (!traceIds.includes(span.traceId)) traceIds.push(span.traceId)

			return {
				id: anchor.id,
				index: index + 1,
				anchorKind: anchor.kind,
				anchor: anchor.span,
				label: turnLabel(anchor.span, turnSpans),
				agentName:
					anchor.span.genAi.agentName ??
					Arr.findFirst(turnSpans, (s) => Boolean(s.genAi.agentName)).pipe(
						Option.map((s) => s.genAi.agentName),
						Option.getOrUndefined,
					),
				startMs,
				endMs,
				durationMs: endMs - startMs,
				spans: turnSpans,
				// Only AI spans that root the turn count: a retried inference that
				// errored and then succeeded is a retry, not a failed turn, and the
				// app's own errored HTTP span is not the agent failing. A tool call
				// roots the turn whenever the run span above it carries no turn id,
				// and one the agent carried on from did not end the turn either.
				// An agent root failing is the run failing, wherever its own parent landed.
				failed:
					(anchor.kind === "agent-root" && spanFailed(anchor.span)) ||
					Arr.some(
						turnSpans,
						(span) =>
							span.isAiSpan &&
							spanFailed(span) &&
							(span.parentSpanId === "" || !spanIds.has(span.parentSpanId)) &&
							!(classifyAiSpan(span) === "tool" && recoveredFrom(span, turnSpans)),
					),
				traceIds,
			}
		},
	)
}

/**
 * The turn the session ended on: the one that finished last, the later-started
 * on a tie. Not the last to start: an orchestrator that fans out sub-agents
 * outlives them, and its outcome is the session's.
 */
export function finalTurnIndex(turns: readonly SessionTurn[]): number {
	return Arr.reduce(turns, turns.length - 1, (final, turn, index) =>
		turn.endMs >= (turns[final]?.endMs ?? Number.NEGATIVE_INFINITY) ? index : final,
	)
}

/** Whether the agent carried on after `failed`: an AI span of the same turn
 *  started once it had ended, and succeeded. */
function recoveredFrom(failed: AiSessionSpan, turnSpans: readonly AiSessionSpan[]): boolean {
	const endMs = spanEndMs(failed)
	return Arr.some(turnSpans, (span) => span.isAiSpan && spanStartMs(span) >= endMs && !spanFailed(span))
}

/**
 * Which turn a span names, by the conversation id it carries or its nearest
 * tagged ancestor's — or `undefined`, leaving it to the caller's time cursor.
 *
 * Only the conversation rule assigns this way, so on rules 2 and 3 this is
 * `undefined` for every span and the partition keeps its existing behaviour.
 *
 * Parentage is followed because a lane's own children are often untagged: the
 * app's HTTP and database spans share the agent's trace and carry no
 * `gen_ai.conversation.id`, and the time cursor would file them into whichever
 * concurrent lane anchored last — the very mis-assignment this exists to stop.
 * `parentSpanId` is intra-trace, so the walk ends at the trace root and the time
 * cursor takes the spans it could not place, which is the best available guess
 * for a span with no link to any turn.
 */
function conversationTurnResolver(
	spans: readonly AiSessionSpan[],
	anchors: readonly TurnAnchor[],
): (span: AiSessionSpan) => number | undefined {
	const sessionIds = sessionIdsOf(spans)
	const turnByConversation = new Map<string, number>()
	Arr.forEach(anchors, (anchor, turn) => {
		if (anchor.conversationId !== undefined) turnByConversation.set(anchor.conversationId, turn)
	})
	if (turnByConversation.size === 0) return () => undefined

	const byId = new Map(Arr.map(spans, (span) => [span.spanId, span]))
	const memo = new Map<string, number | undefined>()

	const resolve = (span: AiSessionSpan): number | undefined => {
		if (memo.has(span.spanId)) return memo.get(span.spanId)
		// Seeded before the walk so a malformed parent cycle ends here instead of
		// recursing forever — the same guard `findAnchors` makes when it walks up.
		memo.set(span.spanId, undefined)

		// The same exclusion `findAnchors` makes: an id that names the session is
		// not a turn key — so it must not claim the span for turn 1.
		const own = span.genAi.conversationId
		let turn = own !== undefined && !sessionIds.has(own) ? turnByConversation.get(own) : undefined
		if (turn === undefined) {
			const parent = byId.get(span.parentSpanId)
			if (parent !== undefined) turn = resolve(parent)
		}
		memo.set(span.spanId, turn)
		return turn
	}
	return resolve
}

/**
 * Which agent-root turn a span sits under, by parentage — or `undefined` for a
 * span with no anchor above it, left to the time cursor.
 *
 * Sub-agents a fan-out launches together run concurrently, often from the same
 * millisecond: by time alone every lane's spans land in whichever anchored last
 * and the others vanish. An agent root has no AI span above it, so the nearest
 * anchor in a span's ancestry is its only one.
 */
function agentRootTurnResolver(
	spans: readonly AiSessionSpan[],
	anchors: readonly TurnAnchor[],
): (span: AiSessionSpan) => number | undefined {
	const turnByAnchor = new Map(Arr.map(anchors, (anchor, turn) => [anchor.span.spanId, turn]))
	const byId = new Map(Arr.map(spans, (span) => [span.spanId, span]))
	const memo = new Map<string, number | undefined>()

	const byParentage = (span: AiSessionSpan): number | undefined => {
		if (memo.has(span.spanId)) return memo.get(span.spanId)
		// Seeded before the walk so a malformed parent cycle ends here.
		memo.set(span.spanId, undefined)
		let turn = turnByAnchor.get(span.spanId)
		if (turn === undefined) {
			const parent = byId.get(span.parentSpanId)
			if (parent !== undefined) turn = byParentage(parent)
		}
		memo.set(span.spanId, turn)
		return turn
	}

	// A span no anchor is above (the runtime's spawn of a sub-agent, an orchestrator's
	// own rejected delegation) belongs to the outermost run open in its trace when it
	// started: by time alone it lands in whichever sub-agent anchored last.
	const runs = Arr.map(anchors, (anchor, turn) => ({
		turn,
		traceId: anchor.span.traceId,
		startMs: spanStartMs(anchor.span),
		endMs: spanEndMs(anchor.span),
	}))
	const enclosingRun = (span: AiSessionSpan): number | undefined => {
		const startMs = spanStartMs(span)
		const open = Arr.filter(
			runs,
			(run) => run.traceId === span.traceId && run.startMs <= startMs && startMs <= run.endMs,
		)
		return Arr.reduce<(typeof runs)[number], (typeof runs)[number] | undefined>(
			open,
			undefined,
			(outer, run) =>
				outer === undefined ||
				run.startMs < outer.startMs ||
				(run.startMs === outer.startMs && run.endMs > outer.endMs)
					? run
					: outer,
		)?.turn
	}
	return (span) => byParentage(span) ?? enclosingRun(span)
}

/**
 * Every session id the spans carry. A `gen_ai.conversation.id` equal to one of
 * them names the session, not a turn.
 *
 * Compared against the whole set rather than the span's own `sessionId`, because
 * the span carrying the conversation id is often not the one carrying the
 * session: an agent engine's `execute_tool` spans take the thread id as their
 * conversation id and no session stamp at all, while the model-call spans beside
 * them carry the session. Read per span, the tool calls became a turn of their
 * own and left every model call behind in another.
 */
function sessionIdsOf(spans: readonly AiSessionSpan[]): ReadonlySet<string> {
	const ids = new Set<string>()
	for (const span of spans) if (span.sessionId !== undefined) ids.add(span.sessionId)
	return ids
}

function findAnchors(ordered: readonly AiSessionSpan[]): readonly TurnAnchor[] {
	const sessionIds = sessionIdsOf(ordered)
	const byConversation = new Map<string, AiSessionSpan>()
	for (const span of ordered) {
		const conversationId = span.genAi.conversationId
		// The gateway derives `maple_ai.session.id` FROM `gen_ai.conversation.id`
		// whenever a vendor's own session key is absent (and for some vendors
		// ahead of it), so there the id names the session and repeats on every
		// span — a partition of one, not a turn key.
		if (conversationId === undefined || sessionIds.has(conversationId)) continue
		if (!byConversation.has(conversationId)) byConversation.set(conversationId, span)
	}
	if (byConversation.size > 1) {
		return Arr.map([...byConversation], ([conversationId, span]) => ({
			span,
			kind: "conversation" as const,
			id: `conversation:${conversationId}`,
			conversationId,
		}))
	}

	const byId = new Map(Arr.map(ordered, (span) => [span.spanId, span]))
	// Not "no parent in the session": the query returns the app's own spans too,
	// so the trace root is an HTTP or workflow span and every agent span has an
	// in-session parent. A turn opens where agent work starts, which is an agent
	// span with no AI span above it anywhere in the chain — any AI ancestor
	// disqualifies, not just an agent one, so a sub-agent invoked from inside a
	// tool or an inference span does not open a turn. That errs toward fewer
	// turns, which is the safe direction.
	const underAiSpan = (span: AiSessionSpan): boolean => {
		const seen = new Set<string>([span.spanId])
		let parent = byId.get(span.parentSpanId)
		while (parent !== undefined && !seen.has(parent.spanId)) {
			if (parent.isAiSpan) return true
			seen.add(parent.spanId)
			parent = byId.get(parent.parentSpanId)
		}
		return false
	}
	// A memory operation is agent work, but bookkeeping around a turn rather than
	// the start of one: as an anchor, a lookup ahead of the agent run would open a
	// turn of its own.
	const agentRoots = Arr.filter(
		ordered,
		(span) =>
			span.isAiSpan &&
			classifyAiSpan(span) === "agent" &&
			!MEMORY_OPS.has(span.genAi.operationName ?? "") &&
			!underAiSpan(span),
	)
	if (agentRoots.length > 0) {
		return Arr.map(agentRoots, (span) => ({
			span,
			kind: "agent-root" as const,
			id: `span:${span.spanId}`,
			conversationId: undefined,
		}))
	}

	const byTrace = new Map<string, AiSessionSpan>()
	for (const span of ordered) if (!byTrace.has(span.traceId)) byTrace.set(span.traceId, span)
	return Arr.map([...byTrace], ([traceId, span]) => ({
		span,
		kind: "trace" as const,
		id: `trace:${traceId}`,
		conversationId: undefined,
	}))
}

/**
 * The turn's label: the newest user message the turn captured.
 *
 * The anchor is asked first — on a `chat`-shaped span `gen_ai.input.messages`
 * is the whole history sent to the model, so a descendant several turns deep
 * still carries turn 1's opening prompt. Model calls come next: the history a
 * model was sent ends on the turn's prompt, while a framework's own node span
 * may carry only what the thread started with (LangGraph's `model` node under a
 * checkpointer holds the thread's first message on every turn).
 *
 * An anchor whose prompt is an earlier user message of the first model call's
 * history is stale, and that call's newest prompt wins: OpenInference's
 * LangChain instrumentor records only the first message of a chain's input, so
 * a thread that re-sends its history (checkpointer state, or messages the
 * caller carries) puts turn 1's prompt on every agent root. A model call whose
 * history does not hold the anchor's prompt (a title or routing call) leaves
 * the anchor standing.
 */
function turnLabel(anchor: AiSessionSpan, turnSpans: readonly AiSessionSpan[]): string | undefined {
	let modelPrompts: readonly string[] = []
	for (const span of turnSpans) {
		if (!isLlmCall(span)) continue
		modelPrompts = userMessageTexts(span.genAi.inputMessages)
		if (modelPrompts.length > 0) break
	}
	const fromAnchor = lastUserMessageText(anchor.genAi.inputMessages)
	if (fromAnchor !== undefined && !modelPrompts.slice(0, -1).includes(fromAnchor)) return fromAnchor
	const fromModel = modelPrompts.at(-1)
	if (fromModel !== undefined) return fromModel
	for (const span of turnSpans) {
		const text = lastUserMessageText(span.genAi.inputMessages)
		if (text !== undefined) return text
	}
	return undefined
}

/** Every user message with readable text in a captured history, oldest first. */
function userMessageTexts(value: unknown): readonly string[] {
	return Arr.isArray(value)
		? Arr.flatMap(value, (entry) => {
				const text = lastUserMessageText([entry])
				return text === undefined ? [] : [text]
			})
		: []
}

/** Longest turn label the page will render before eliding — a captured prompt
 *  can be tens of kilobytes, and the title is one line. */
const MAX_LABEL_LENGTH = 80

/**
 * The newest user text inside a `gen_ai.input.messages` value.
 *
 * The value is captured JSON whose exact shape belongs to the vendor, so this
 * walks it and gives up rather than guessing: the documented shape is
 * `[{ role, parts: [{ type: "text", content }] }]`, and vendors also emit the
 * content as a bare string. The LAST user entry is the prompt this call was
 * made for; the ones before it are the chat history. Message capture is opt-in
 * and off by default, so returning `undefined` is the ordinary case, not a
 * failure.
 */
/** The newest user message with readable text in a captured history — exported
 *  so a loader that trims histories keeps exactly the message this reads. */
export function lastUserMessageText(value: unknown): string | undefined {
	if (!Arr.isArray(value)) return undefined
	for (let i = value.length - 1; i >= 0; i--) {
		const entry: unknown = value[i]
		// Case-insensitively: vendors write "User" as readily as "user", and the
		// transcript's own row builders already read the role that way.
		if (!isRecord(entry) || Str.toLowerCase(String(entry.role)) !== "user") continue
		const text = messageText(entry.parts) ?? messageText(entry.content)
		if (text !== undefined) return text
	}
	return undefined
}

/** Leading blocks a framework writes into the prompt (`<run-status>…</run-status>`,
 *  `<system-reminder>…`): hyphenated tags, so a user's own `<task>` stays prose. */
const INJECTED_BLOCKS = /^(?:\s*<([a-z][\w]*-[\w-]+)\b[^>]*>[\s\S]*?<\/\1>)+\s*/i

/** The text without the framework blocks it opens with; empty when that was all of it. */
export function withoutInjectedBlocks(text: string): string {
	return Str.replace(INJECTED_BLOCKS, "")(text)
}

function messageText(value: unknown): string | undefined {
	if (typeof value === "string") return proseLine(withoutInjectedBlocks(value))
	if (!Arr.isArray(value)) return undefined
	for (const part of value) {
		if (typeof part === "string") {
			const text = proseLine(withoutInjectedBlocks(part))
			if (text !== undefined) return text
		}
		if (!isRecord(part)) continue
		const content = typeof part.content === "string" ? part.content : part.text
		if (typeof content === "string") {
			const text = proseLine(withoutInjectedBlocks(content))
			if (text !== undefined) return text
		}
	}
	return undefined
}

/** A framework's own heading over the prompt, which names what follows rather
 *  than saying it: smolagents opens every task with "New task:". Matched
 *  literally, since a user's "Fix this:" over pasted code is the prompt. */
const LEAD_IN = /^new task:$/i

/** The message's first non-empty line, collapsed to one line's worth of text —
 *  or the line after it, when the first is a lead-in. */
function proseLine(value: string): string | undefined {
	const lines: string[] = []
	for (const rawLine of Str.split("\n")(value)) {
		const line = Str.replace(/\s+/g, " ")(Str.trim(rawLine))
		if (line.length > 0 && lines.push(line) === 2) break
	}
	const [first, second] = lines
	if (first === undefined) return undefined
	const line = second !== undefined && LEAD_IN.test(first) ? second : first
	return line.length > MAX_LABEL_LENGTH ? `${Str.slice(0, MAX_LABEL_LENGTH - 1)(line)}…` : line
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Arr.isArray(value)
}
