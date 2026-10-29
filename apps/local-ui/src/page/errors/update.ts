import type { Cached } from "../../data/cached"
import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import { Option, Record, Result } from "effect"
import { AsyncData } from "foldkit"
import { accept, idle, acceptCached } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams, withParams } from "../contract"
import { ReadClock, ReadRefreshClock, FetchByType, FetchFacets, FetchSummary, FetchTraces } from "./command"
import { ErrorsComposition } from "./composition"
import type { ErrorTrace, ErrorTypeRow } from "./fetch"
import type { LoadFailure } from "../../data/local-query"
import { cardOf, load, loadCard, boundsOf } from "./load"
import type { Model } from "./model"

type PageCommand =
	| ReturnType<typeof ReadClock>
	| ReturnType<typeof ReadRefreshClock>
	| ReturnType<typeof FetchSummary>
	| ReturnType<typeof FetchByType>
	| ReturnType<typeof FetchFacets>
	| ReturnType<typeof FetchTraces>
type UpdateReturn = Readonly<{ model: Model; commands?: ReadonlyArray<PageCommand>; outMessage?: PageOutMessage }>

/** The filter rail's sections and the guide's copy buttons are assembled by their Bindings. */
export const init = ErrorsComposition.makeInit((_context: PageContext) => ({
	model: {
		_tag: "ErrorsPage",
		maybeAnchorMs: Option.none(),
		nowMs: 0,
		summary: idle(),
		byType: idle(),
		byTypeUpdatedAtMs: 0,
		facets: idle(),
		cards: {},
		isRefreshing: false,
	},
	commands: [ReadClock()],
}))

const navigate = (model: Model, context: PageContext, updates: Record<string, string | null>): UpdateReturn => ({
	model,
	outMessage: replaceParams(context.location, updates),
})

const setRange = (model: Model, context: PageContext, range: string): UpdateReturn => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

const settleRefresh = (model: Model): Model => {
	const isLoading = (data: AsyncData.AsyncData<unknown, unknown>) =>
		AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
	const slots = [model.summary.data, model.byType.data, model.facets.data, ...Object.values(model.cards).map((card) => card.traces.data)]
	return model.isRefreshing && !slots.some(isLoading) ? { ...model, isRefreshing: false } : model
}

/** Cards are keyed by fingerprint: a type no longer listed unmounts, and its state goes with it. */
const pruneCards = (model: Model, rows: ReadonlyArray<ErrorTypeRow>): Model => {
	const listed = new Set(rows.map((row) => row.fingerprintHash))
	return { ...model, cards: Record.filter(model.cards, (_, fingerprintHash) => listed.has(fingerprintHash)) }
}

/** `ErrorTypeCard`'s toggle: opening it asks for its traces (a held answer is reused). */
const toggleCard = (model: Model, context: PageContext, fingerprintHash: string): UpdateReturn => {
	const card = cardOf(model, fingerprintHash)
	const next = { ...model, cards: Record.set(model.cards, fingerprintHash, { ...card, isExpanded: !card.isExpanded }) }
	return loadCard(next, context, fingerprintHash)
}

const settleTraces = (
	model: Model,
	fingerprintHash: string,
	key: string,
	result: Result.Result<ReadonlyArray<ErrorTrace>, LoadFailure>,
	atMs: number | null = null,
): Model => {
	const card = cardOf(model, fingerprintHash)
	return Record.has(model.cards, fingerprintHash)
		? settleRefresh({ ...model, cards: Record.set(model.cards, fingerprintHash, { ...card, traces: accept(card.traces, key, result, atMs) }) })
		: model
}

type Slotted = "summary" | "byType" | "facets"

/** A cached result is on screen: fetch the real one (`readsCache: false`), unless it is fresh. */
const refetchAfterCache = (model: Model, context: PageContext, which: Slotted, isFresh: boolean): UpdateReturn => {
	const maybeBounds = boundsOf(model, context)
	if (isFresh || Option.isNone(maybeBounds)) return { model: settleRefresh(model) }
	const args = { key: model[which].key ?? "", search: context.location.search, ...maybeBounds.value, apiBase: context.env.apiBase, readsCache: false }
	const command = which === "summary" ? FetchSummary(args) : which === "byType" ? FetchByType(args) : FetchFacets(args)
	return { model: settleRefresh(model), commands: [command] }
}

/** A card's cached traces: shown, then fetched unless fresh. */
const cardFromCache = (model: Model, context: PageContext, fingerprintHash: string, key: string, cached: Cached<ReadonlyArray<ErrorTrace>>): UpdateReturn => {
	const card = cardOf(model, fingerprintHash)
	const maybeBounds = boundsOf(model, context)
	if (!Record.has(model.cards, fingerprintHash) || card.traces.key !== key || Option.isNone(maybeBounds)) return { model }
	const next = { ...model, cards: Record.set(model.cards, fingerprintHash, { ...card, traces: acceptCached(card.traces, key, cached, cached.isFresh) }) }
	const fetch = FetchTraces({ key, fingerprintHash, search: context.location.search, ...maybeBounds.value, apiBase: context.env.apiBase, readsCache: false })
	return { model: settleRefresh(next), commands: cached.isFresh ? [] : [fetch] }
}

export const update = ErrorsComposition.makeUpdate.withContext((context: PageContext) => ({
	CompletedReadClock: (model, { nowMs }) => {
		const loaded = load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context)
		// `ErrorsView` reads `useSignalPresence("traces")` on mount, empty or not.
		return { ...loaded, outMessage: PageOutMessage.RequestedSignalPresence() }
	},
	SucceededFetchSummary: (model, { key, summary, fetchedAtMs }) =>
		({ model: settleRefresh({ ...model, summary: accept(model.summary, key, Result.succeed(summary), fetchedAtMs) }) }),
	FoundCachedSummary: (model, { key, cached }) =>
		model.summary.key === key
			? refetchAfterCache({ ...model, summary: acceptCached(model.summary, key, cached, cached.isFresh) }, context, "summary", cached.isFresh)
			: { model },
	FoundCachedByType: (model, { key, cached }) =>
		model.byType.key === key
			? refetchAfterCache(
					pruneCards({ ...model, byType: acceptCached(model.byType, key, cached, cached.isFresh), byTypeUpdatedAtMs: cached.updatedAtMs }, cached.data),
					context,
					"byType",
					cached.isFresh,
				)
			: { model },
	FoundCachedFacets: (model, { key, cached }) =>
		model.facets.key === key
			? refetchAfterCache({ ...model, facets: acceptCached(model.facets, key, cached, cached.isFresh) }, context, "facets", cached.isFresh)
			: { model },
	FoundCachedTraces: (model, { fingerprintHash, key, cached }) => cardFromCache(model, context, fingerprintHash, key, cached),
	FailedFetchSummary: (model, { key, failure }) =>
		({ model: settleRefresh({ ...model, summary: accept(model.summary, key, Result.fail(failure)) }) }),
	SucceededFetchByType: (model, { key, rows, fetchedAtMs }) => {
		if (model.byType.key !== key) return { model }
		const next = { ...model, byType: accept(model.byType, key, Result.succeed(rows), fetchedAtMs), byTypeUpdatedAtMs: fetchedAtMs }
		return { model: settleRefresh(pruneCards(next, rows)) }
	},
	FailedFetchByType: (model, { key, failure }) => {
		const byType = accept(model.byType, key, Result.fail(failure))
		// The error state replaces the list, unmounting every card.
		const cards = AsyncData.isFailure(byType.data) ? {} : model.cards
		return { model: settleRefresh({ ...model, byType, cards }) }
	},
	SucceededFetchFacets: (model, { key, facets, fetchedAtMs }) =>
		({ model: settleRefresh({ ...model, facets: accept(model.facets, key, Result.succeed(facets), fetchedAtMs) }) }),
	FailedFetchFacets: (model, { key, failure }) =>
		({ model: settleRefresh({ ...model, facets: accept(model.facets, key, Result.fail(failure)) }) }),
	ClickedErrorType: (model, { fingerprintHash }) => toggleCard(model, context, fingerprintHash),
	SucceededFetchTraces: (model, { fingerprintHash, key, traces, fetchedAtMs }) =>
		({ model: settleTraces(model, fingerprintHash, key, Result.succeed(traces), fetchedAtMs) }),
	FailedFetchTraces: (model, { fingerprintHash, key, failure }) =>
		({ model: settleTraces(model, fingerprintHash, key, Result.fail(failure)) }),
	ClickedRetryTraces: (model, { fingerprintHash }) => loadCard(model, context, fingerprintHash, true),
	ClickedOpenFilters: (model) => ({ model, outMessage: PageOutMessage.RequestedFilterDrawer() }),
	ClickedRefresh: (model) =>
		model.isRefreshing ? { model } : { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
	CompletedReadRefreshClock: (model, { nowMs }) => {
		const next = snapToMinute(nowMs)
		// `advance()`: a new minute re-anchors the window (new keys); else refetch in place.
		if (Option.getOrNull(model.maybeAnchorMs) !== next)
			return load({ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false }, context)
		const refetch = load({ ...model, nowMs }, context, true)
		return { model: settleRefresh(refetch.model), commands: refetch.commands, outMessage: PageOutMessage.RefetchedInPlace() }
	},
	ToggledRootOnly: (model) =>
		navigate(model, context, { root: queryOf(context.location).get("root") === "1" ? null : "1" }),
	ToggledFacetOption: (model, { param, name }) =>
		navigate(model, context, { [param]: queryOf(context.location).get(param) === name ? null : name }),
	ClickedClearFilters: (model) => navigate(model, context, { service: null, env: null, root: null }),
	ChangedRange: (model, { range }) => setRange(model, context, range),
	ClickedWidenRange: (model) => setRange(model, context, WIDEST_RANGE),
	/** `useLocalErrors` reads the hash query: a filter or range change reloads under new keys. */
	InformedOfLocationChange: (model) => load(model, context),
}))
