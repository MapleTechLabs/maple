import type { Resources } from "../../platform/resources"
import { Array, Option, Result } from "effect"
import { AsyncData, type Command, type Update } from "foldkit"
import { accept, idle, keyOf, request, acceptCached } from "../../data/slot"
import { hrefFor, queryOf } from "../../route"
import { type PageContext, PageOutMessage } from "../contract"
import { updateCopy } from "../kit/copies"
import { FetchDetail, FetchTraces, FetchTranscript, ReadClock } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PageOutMessage, Resources>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

/** Detail-page params that must not leak back into the list's filters. */
const DETAIL_ONLY_PARAMS = ["spanId", "view"]

const detailKey = (sessionId: string) => keyOf("session", sessionId)
const transcriptKey = (sessionId: string) => keyOf("session-transcript", sessionId)

/** The session's detail and transcript; `force` refetches. */
const loadSession = (model: Model, apiBase: string, force: boolean): Readonly<{ model: Model; commands?: Commands }> => {
	const { sessionId } = model
	const detail = request(model.detail, detailKey(sessionId), force)
	const transcript = request(model.transcript, transcriptKey(sessionId), force)
	return {
		model: {
			...model,
			detail: Option.getOrElse(detail, () => model.detail),
			transcript: Option.getOrElse(transcript, () => model.transcript),
		},
		commands: Array.getSomes([
			Option.map(detail, () => FetchDetail({ key: detailKey(sessionId), sessionId, apiBase, readsCache: !force })),
			Option.map(transcript, () => FetchTranscript({ key: transcriptKey(sessionId), sessionId, apiBase, readsCache: !force })),
		]),
	}
}

/** The session's traces: only once the detail lists some. */
const loadTraces = (model: Model, apiBase: string, force: boolean): Readonly<{ model: Model; commands?: Commands }> => {
	const traceIds = Option.match(AsyncData.getData(model.detail.data), { onNone: () => [], onSome: (detail) => detail?.traceIds ?? [] })
	if (traceIds.length === 0) return { model }
	const key = keyOf("session-traces", traceIds)
	return Option.match(request(model.traces, key, force), {
		onNone: () => ({ model }),
		onSome: (traces) => ({ model: { ...model, traces }, commands: [FetchTraces({ key, traceIds, apiBase, readsCache: !force && model.traces.key !== key })] }),
	})
}

const settleRefresh = (model: Model): Model => {
	const isLoading = (data: AsyncData.AsyncData<unknown, unknown>) => AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
	return model.isRefreshing && ![model.detail.data, model.transcript.data, model.traces.data].some(isLoading)
		? { ...model, isRefreshing: false }
		: model
}

export const init = (context: PageContext, sessionId: string): Readonly<{ model: Model; commands: Commands }> => {
	const loaded = loadSession(
		{
			_tag: "SessionDetailPage",
			sessionId,
			nowMs: 0,
			detail: idle(),
			transcript: idle(),
			traces: idle(),
			detailUpdatedAtMs: 0,
			isRefreshing: false,
			copies: {},
		},
		context.env.apiBase,
		false,
	)
	return { model: loaded.model, commands: [ReadClock(), ...(loaded.commands ?? [])] }
}

/** The page reads nothing from the fragment's query. */
export const locationChanged = (model: Model, _context: PageContext): UpdateReturn => ({ model })

/** `back("/sessions")`: history back, or the list with the detail-only params dropped. */
const back = (model: Model, context: PageContext): UpdateReturn => {
	const fallback = queryOf(context.location)
	DETAIL_ONLY_PARAMS.forEach((key) => fallback.delete(key))
	return { model, outMessage: PageOutMessage.RequestedBack({ fallbackHash: hrefFor("/sessions", fallback) }) }
}

/** `invalidateQueries(["local"])`: every query the page holds refetches; the spinner waits for all. */
const refresh = (model: Model, context: PageContext): UpdateReturn => {
	if (model.isRefreshing) return { model }
	const session = loadSession({ ...model, isRefreshing: true }, context.env.apiBase, true)
	const traces = loadTraces(session.model, context.env.apiBase, true)
	return {
		model: traces.model,
		commands: [...(session.commands ?? []), ...(traces.commands ?? [])],
		outMessage: PageOutMessage.RefetchedInPlace(),
	}
}

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		CompletedReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		SucceededFetchDetail: ({ key, detail, fetchedAtMs }) => {
			const isCurrent = model.detail.key === key
			const next = {
				...model,
				detail: accept(model.detail, key, Result.succeed(detail), fetchedAtMs),
				detailUpdatedAtMs: isCurrent ? fetchedAtMs : model.detailUpdatedAtMs,
			}
			const traces = loadTraces(next, context.env.apiBase, false)
			return { model: settleRefresh(traces.model), commands: traces.commands }
		},
		FailedFetchDetail: ({ key, failure }) => ({
			model: settleRefresh({ ...model, detail: accept(model.detail, key, Result.fail(failure)) }),
		}),
		SucceededFetchTranscript: ({ key, events, fetchedAtMs }) => ({
			model: settleRefresh({ ...model, transcript: accept(model.transcript, key, Result.succeed(events), fetchedAtMs) }),
		}),
		FoundCachedDetail: ({ key, cached }) => {
			if (model.detail.key !== key) return { model }
			const next = { ...model, detail: acceptCached(model.detail, key, cached, cached.isFresh), detailUpdatedAtMs: cached.updatedAtMs }
			const traces = loadTraces(next, context.env.apiBase, false)
			const fetch = cached.isFresh ? [] : [FetchDetail({ key, sessionId: model.sessionId, apiBase: context.env.apiBase, readsCache: false })]
			return { model: settleRefresh(traces.model), commands: [...fetch, ...(traces.commands ?? [])] }
		},
		FoundCachedTranscript: ({ key, cached }) =>
			model.transcript.key === key
				? {
						model: settleRefresh({ ...model, transcript: acceptCached(model.transcript, key, cached, cached.isFresh) }),
						commands: cached.isFresh ? [] : [FetchTranscript({ key, sessionId: model.sessionId, apiBase: context.env.apiBase, readsCache: false })],
					}
				: { model },
		FoundCachedTraces: ({ key, cached }) => {
			if (model.traces.key !== key) return { model }
			const next = { ...model, traces: acceptCached(model.traces, key, cached, cached.isFresh) }
			const traceIds = Option.match(AsyncData.getData(next.detail.data), { onNone: () => [], onSome: (detail) => detail?.traceIds ?? [] })
			return {
				model: settleRefresh(next),
				commands: cached.isFresh ? [] : [FetchTraces({ key, traceIds, apiBase: context.env.apiBase, readsCache: false })],
			}
		},
		FailedFetchTranscript: ({ key, failure }) => ({
			model: settleRefresh({ ...model, transcript: accept(model.transcript, key, Result.fail(failure)) }),
		}),
		SucceededFetchTraces: ({ key, traces, fetchedAtMs }) => ({
			model: settleRefresh({ ...model, traces: accept(model.traces, key, Result.succeed(traces), fetchedAtMs) }),
		}),
		FailedFetchTraces: ({ key, failure }) => ({
			model: settleRefresh({ ...model, traces: accept(model.traces, key, Result.fail(failure)) }),
		}),
		ClickedBack: () => back(model, context),
		ClickedRefresh: () => refresh(model, context),
		ClickedRetryDetail: () => {
			const detail = request(model.detail, detailKey(model.sessionId), true)
			return Option.match(detail, {
				onNone: () => ({ model }),
				onSome: (next) => ({
					model: { ...model, detail: next },
					commands: [FetchDetail({ key: detailKey(model.sessionId), sessionId: model.sessionId, apiBase: context.env.apiBase, readsCache: false })],
				}),
			})
		},
		GotCopyMessage: ({ id, message: child }) => {
			const next = updateCopy(model.copies, id, child, (copyId, copyMessage) => Message.GotCopyMessage({ id: copyId, message: copyMessage }))
			return { model: { ...model, copies: next.copies }, commands: next.commands }
		},
	})
