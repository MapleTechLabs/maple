import type { Resources } from "../../platform/resources"
import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Option, Result } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { Cached } from "../../data/cached"
import { accept, acceptCached, idle } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams, withParams } from "../contract"
import { updateCopy } from "../kit/copies"
import { FetchCatalog, ReadClock, ReadRefreshClock, WaitSearchDebounce } from "./command"
import { filtersOf, visibleEntries } from "./derive"
import { boundsOf, load } from "./load"
import { Message } from "./message"
import type { Catalog, Model } from "./model"
import type { LoadFailure } from "../../data/local-query"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PageOutMessage, Resources>

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

export const init = (
	context: PageContext,
): Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }> => {
	const q = queryOf(context.location).get("q") ?? ""
	return {
		model: {
			_tag: "ServicesPage",
			maybeAnchorMs: Option.none(),
			nowMs: 0,
			catalog: idle(),
			unfiltered: idle(),
			catalogUpdatedAtMs: 0,
			search: { text: q, version: 0, sent: q },
			sections: FilterSections.init(),
			isRefreshing: false,
			copies: {},
		},
		commands: [ReadClock(), Command.mapMessage(FilterSections.ReadRemembered(), toSections)],
	}
}

/** An empty list renders `SignalEmptyState`, which reads the shared signal presence. */
const withPresence = (step: UpdateReturn, context: PageContext): UpdateReturn => {
	const isLoaded = Option.isSome(AsyncData.getData(step.model.catalog.data)) && !step.model.catalog.isPlaceholder
	const isEmpty = visibleEntries(step.model, filtersOf(queryOf(context.location))).length === 0
	return isLoaded && isEmpty && step.outMessage === undefined
		? { ...step, outMessage: PageOutMessage.RequestedSignalPresence() }
		: step
}

/** The hash changed: sync the search input unless it is the page's own debounced echo. */
export const locationChanged = (model: Model, context: PageContext): UpdateReturn => {
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

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn => {
	const query = queryOf(context.location)
	return Message.match<UpdateReturn>(message, {
		CompletedReadClock: ({ nowMs }) =>
			load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		SucceededFetchCatalog: ({ key, catalog, fetchedAtMs }) => {
			const catalogUpdatedAtMs = model.catalog.key === key ? fetchedAtMs : model.catalogUpdatedAtMs
			const next = settleRefresh({ ...settled(model, key, Result.succeed(catalog), fetchedAtMs), catalogUpdatedAtMs })
			return model.catalog.key === key ? withPresence({ model: next }, context) : { model: next }
		},
		FoundCachedCatalog: ({ key, cached }) => settledFromCache(model, context, key, cached),
		FailedFetchCatalog: ({ key, failure }) => ({ model: settleRefresh(settled(model, key, Result.fail(failure))) }),
		ClickedOpenFilters: () => ({ model, outMessage: PageOutMessage.RequestedFilterDrawer() }),
		ClickedRefresh: () =>
			model.isRefreshing ? { model } : { model: { ...model, isRefreshing: true }, commands: [ReadRefreshClock()] },
		CompletedReadRefreshClock: ({ nowMs }) => {
			const next = snapToMinute(nowMs)
			// `advance()`: a new minute re-anchors the window (new keys); else refetch in place.
			if (Option.getOrNull(model.maybeAnchorMs) !== next)
				return load({ ...model, nowMs, maybeAnchorMs: Option.some(next), isRefreshing: false }, context)
			const refetch = load({ ...model, nowMs }, context, true)
			return { model: settleRefresh(refetch.model), commands: refetch.commands, outMessage: PageOutMessage.RefetchedInPlace() }
		},
		ChangedSearch: ({ text }) => searchStep(model, text),
		ClickedClearSearch: () => searchStep(model, ""),
		ElapsedSearchDebounce: ({ version }) => {
			if (version !== model.search.version) return { model }
			const trimmed = model.search.text.trim()
			return navigate({ ...model, search: { ...model.search, sent: trimmed } }, context, { q: trimmed === "" ? null : trimmed })
		},
		ToggledFacetOption: ({ param, name }) => navigate(model, context, { [param]: query.get(param) === name ? null : name }),
		ClickedClearFacets: () => navigate(model, context, { env: null, ns: null }),
		ClickedClearFilters: () => navigate(model, context, { env: null, ns: null, q: null }),
		ChangedRange: ({ range }) => setRange(model, context, range),
		ClickedWidenRange: () => setRange(model, context, WIDEST_RANGE),
		GotFilterSectionsMessage: ({ message: child }) => {
			const next = FilterSections.update(model.sections, child)
			return { model: { ...model, sections: next.model }, commands: Command.mapMessages(next.commands ?? [], toSections) }
		},
		GotCopyMessage: ({ id, message: child }) => {
			const next = updateCopy(model.copies, id, child, (copyId, copyMessage) => Message.GotCopyMessage({ id: copyId, message: copyMessage }))
			return { model: { ...model, copies: next.copies }, commands: next.commands }
		},
	})
}
