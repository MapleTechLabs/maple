import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import { Option, Result } from "effect"
import { AsyncData } from "foldkit"
import type { Cached } from "../../data/cached"
import { accept, acceptCached, idle } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams, withParams } from "../contract"
import { FetchCatalog, ReadClock, ReadRefreshClock, type ServicesCommand, WaitSearchDebounce } from "./command"
import { ServicesComposition } from "./composition"
import { filtersOf, visibleEntries } from "./derive"
import { boundsOf, load } from "./load"
import type { Catalog, Model } from "./model"
import type { LoadFailure } from "../../data/local-query"

export type UpdateReturn = Readonly<{
	model: Model
	commands?: ReadonlyArray<ServicesCommand>
	outMessage?: PageOutMessage
}>
/** The page's own fields; the filter sections and copy buttons are assembled by their Bindings. */
type PageFields = Omit<Model, "sections" | "endpointCopy" | "envCopy">

export const init = ServicesComposition.makeInit((context: PageContext) => {
	const q = queryOf(context.location).get("q") ?? ""
	const model: PageFields = {
		_tag: "ServicesPage",
		maybeAnchorMs: Option.none(),
		nowMs: 0,
		catalog: idle(),
		unfiltered: idle(),
		catalogUpdatedAtMs: 0,
		search: { text: q, version: 0, sent: q },
		isRefreshing: false,
	}
	return { model, commands: [ReadClock()] }
})

/** An empty list renders `SignalEmptyState`, which reads the shared signal presence. */
const withPresence = (step: UpdateReturn, context: PageContext): UpdateReturn => {
	const isLoaded = Option.isSome(AsyncData.getData(step.model.catalog.data)) && !step.model.catalog.isPlaceholder
	const isEmpty = visibleEntries(step.model, filtersOf(queryOf(context.location))).length === 0
	return isLoaded && isEmpty && step.outMessage === undefined
		? { ...step, outMessage: PageOutMessage.RequestedSignalPresence() }
		: step
}

/** The hash changed: sync the search input unless it is the page's own debounced echo. */
const locationChanged = (model: Model, context: PageContext): UpdateReturn => {
	const q = queryOf(context.location).get("q") ?? ""
	const search = q === model.search.sent ? model.search : { ...model.search, text: q, sent: q }
	return withPresence(load({ ...model, search }, context), context)
}

const navigate = (model: Model, context: PageContext, updates: Record<string, string | null>): UpdateReturn => ({
	model,
	outMessage: replaceParams(context.location, updates),
})

const setRange = (model: Model, context: PageContext, range: string): UpdateReturn => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

/** The refresh spinner stops once nothing the refresh started is still loading. */
const settleRefresh = (model: Model): Model => {
	const isLoading = (data: AsyncData.AsyncData<unknown, unknown>) =>
		AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
	return model.isRefreshing && !isLoading(model.catalog.data) && !isLoading(model.unfiltered.data)
		? { ...model, isRefreshing: false }
		: model
}

/** One fetch answers whichever slots hold its key (both, while no filter is set). */
const settled = (model: Model, key: string, result: Result.Result<Catalog, LoadFailure>, atMs: number | null = null): Model => ({
	...model,
	catalog: accept(model.catalog, key, result, atMs),
	unfiltered: accept(model.unfiltered, key, result, atMs),
})

/** The cache answered a slice first: whichever slots hold its key show it, then the fetch runs. */
const settledFromCache = (model: Model, context: PageContext, key: string, cached: Cached<Catalog>): UpdateReturn => {
	const next = {
		...model,
		catalog: acceptCached(model.catalog, key, cached, cached.isFresh),
		unfiltered: acceptCached(model.unfiltered, key, cached, cached.isFresh),
		catalogUpdatedAtMs: model.catalog.key === key ? cached.updatedAtMs : model.catalogUpdatedAtMs,
	}
	const holder = next.catalog.key === key ? "catalog" : next.unfiltered.key === key ? "unfiltered" : null
	if (holder === null || cached.isFresh) return { model: settleRefresh(next) }
	const bounds = Option.getOrNull(boundsOf(next, context))
	if (bounds === null) return { model: next }
	const filters = filtersOf(queryOf(context.location))
	const isRows = holder === "catalog"
	return {
		model: next,
		commands: [
			FetchCatalog({
				key,
				env: isRows ? (filters.env ?? null) : null,
				ns: isRows ? (filters.ns ?? null) : null,
				...bounds,
				apiBase: context.env.apiBase,
				readsCache: false,
			}),
		],
	}
}

const searchStep = (model: Model, text: string): UpdateReturn => {
	const version = model.search.version + 1
	return { model: { ...model, search: { ...model.search, text, version } }, commands: [WaitSearchDebounce({ version })] }
}

export const update = ServicesComposition.makeUpdate.withContext((context: PageContext) => {
	const query = queryOf(context.location)
	return {
		CompletedReadClock: (model, { nowMs }) =>
			load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		SucceededFetchCatalog: (model, { key, catalog, fetchedAtMs }) => {
			const catalogUpdatedAtMs = model.catalog.key === key ? fetchedAtMs : model.catalogUpdatedAtMs
			const next = settleRefresh({ ...settled(model, key, Result.succeed(catalog), fetchedAtMs), catalogUpdatedAtMs })
			return model.catalog.key === key ? withPresence({ model: next }, context) : { model: next }
		},
		FoundCachedCatalog: (model, { key, cached }) => settledFromCache(model, context, key, cached),
		FailedFetchCatalog: (model, { key, failure }) => ({ model: settleRefresh(settled(model, key, Result.fail(failure))) }),
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
		ChangedSearch: (model, { text }) => searchStep(model, text),
		ClickedClearSearch: (model) => searchStep(model, ""),
		ElapsedSearchDebounce: (model, { version }) => {
			if (version !== model.search.version) return { model }
			const trimmed = model.search.text.trim()
			return navigate({ ...model, search: { ...model.search, sent: trimmed } }, context, { q: trimmed === "" ? null : trimmed })
		},
		ToggledFacetOption: (model, { param, name }) => navigate(model, context, { [param]: query.get(param) === name ? null : name }),
		ClickedClearFacets: (model) => navigate(model, context, { env: null, ns: null }),
		ClickedClearFilters: (model) => navigate(model, context, { env: null, ns: null, q: null }),
		ChangedRange: (model, { range }) => setRange(model, context, range),
		ClickedWidenRange: (model) => setRange(model, context, WIDEST_RANGE),
		InformedOfLocationChange: (model) => locationChanged(model, context),
	}
})
