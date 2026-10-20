import type { AiSessionSpan } from "@maple/domain/http"
import {
	buildSessionSummary,
	buildSessionTurns,
	type SessionSummary,
	sessionToolResults,
	type SessionToolResults,
	type SessionTurn,
} from "@maple/agent-sessions"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { type Model, SESSION_VIEWS, type SessionView } from "./model"

// The hook half of `useSessionSpans` and what the route derives from it.

/** `SessionLoadProgress` without its `retry` (a Message here). */
export type LoadProgress = Readonly<{
	phase: "agent" | "app" | "complete" | "failed"
	agentSpansComplete: boolean
	loadedSpans: number
	loadedAgentSpans: number
}>

/** First occurrence wins, page order kept. */
const dedupeInOrder = (spans: ReadonlyArray<AiSessionSpan>): ReadonlyArray<AiSessionSpan> => {
	const seen = new Set<string>()
	return spans.filter((span) => {
		if (seen.has(span.spanId)) return false
		seen.add(span.spanId)
		return true
	})
}

/** Every span loaded so far: the first page, then the agent's pages, then the app's. */
export const loadedSpans = (model: Model): ReadonlyArray<AiSessionSpan> => {
	const first = Option.match(AsyncData.getData(model.firstPage.data), {
		onNone: () => [],
		onSome: (page) => page.data,
	})
	const isOwnKey = model.more.key === model.firstPage.key
	return dedupeInOrder([
		...first,
		...(isOwnKey ? model.more.agentPages.flatMap((page) => page.data) : []),
		...(isOwnKey ? model.more.appPages.flatMap((page) => page.data) : []),
	])
}

/** `undefined` for a session that fit its first page: then the spans in hand are the session. */
export const progressOf = (model: Model, spans: ReadonlyArray<AiSessionSpan>): LoadProgress | undefined => {
	const first = Option.getOrUndefined(AsyncData.getData(model.firstPage.data))
	if (first === undefined || first.nextCursor === null) return undefined
	const pages = model.more.key === model.firstPage.key ? model.more.agentPages : []
	const agentDone = pages.length > 0 && pages[pages.length - 1]?.nextCursor === null
	const phase =
		model.more.status === "failed"
			? "failed"
			: model.more.status === "complete"
				? "complete"
				: agentDone
					? "app"
					: "agent"
	return {
		phase,
		agentSpansComplete: agentDone,
		loadedSpans: spans.length,
		loadedAgentSpans: spans.filter((span) => span.isAiSpan).length,
	}
}

export type SessionData = Readonly<{
	spans: ReadonlyArray<AiSessionSpan>
	turns: ReadonlyArray<SessionTurn>
	summary: SessionSummary
	toolResults: SessionToolResults
	progress: LoadProgress | undefined
}>

const buildSessionData = (model: Model): SessionData => {
	const spans = loadedSpans(model)
	const turns = buildSessionTurns(spans)
	return {
		spans,
		turns,
		summary: buildSessionSummary({ spans, turns }),
		toolResults: sessionToolResults(turns.flatMap((turn) => turn.spans)),
		progress: progressOf(model, spans),
	}
}

// A pure cache over the spans: the pages in hand are immutable, so their
// identities key the result and a scroll or tooltip step reuses it instead of rebuilding the turns.
const built = new WeakMap<object, WeakMap<object, Readonly<{ key: string | null; data: SessionData }>>>()

/** What every view reads, built once per change of the spans in hand. */
export const sessionData = (model: Model): SessionData => {
	const byMore = built.get(model.firstPage.data) ?? new WeakMap()
	const hit = byMore.get(model.more)
	if (hit !== undefined && hit.key === model.firstPage.key) return hit.data
	const data = buildSessionData(model)
	byMore.set(model.more, { key: model.firstPage.key, data })
	built.set(model.firstPage.data, byMore)
	return data
}

const isSessionView = (value: string): value is SessionView => SESSION_VIEWS.some((view) => view === value)

/** An unknown or absent `?view=` reads as the Overview: the param is a hint from a link. */
export const viewOf = (view: string | undefined): SessionView =>
	view !== undefined && isSessionView(view) ? view : "overview"
