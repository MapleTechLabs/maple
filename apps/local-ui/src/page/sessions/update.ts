import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import { Option, Result } from "effect"
import { AsyncData } from "foldkit"
import { accept, acceptCached, idle } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage } from "../contract"
import { ReadClock, ReadRefreshClock, WaitSearchDebounce } from "./command"
import { SessionsComposition } from "./composition"
import { filtersOf } from "./fetch"
import { fetchAfterCache, load } from "./load"
import type { Model } from "./model"
import { appendPage, loadMore, navigate, setRange, settleRefresh } from "./update-helpers"

const SIDEBAR_FILTERS = { service: null, browser: null, device: null, errors: null }

/** The filter rail's sections and the guide's copy buttons start through their Bindings. */
export const init = SessionsComposition.makeInit((context: PageContext) => {
	const q = queryOf(context.location).get("q") ?? ""
	return {
		model: {
			_tag: "SessionsPage",
			maybeAnchorMs: Option.none(),
			nowMs: 0,
			sessions: idle(),
			facets: idle(),
			isFetchingNextPage: false,
			pageGeneration: 0,
			sessionsUpdatedAtMs: 0,
			search: { text: q, version: 0, sent: q },
			isRefreshing: false,
		},
		commands: [ReadClock()],
	}
})

/** The hash changed: keep the search input in sync unless it is the page's own echo, then load. */
const locationChanged = (model: Model, context: PageContext) => {
	const q = queryOf(context.location).get("q") ?? ""
	const search = q === model.search.sent ? model.search : { ...model.search, text: q, sent: q }
	return load({ ...model, search }, context)
}

const typed = (model: Model, text: string) => {
	const version = model.search.version + 1
	return { model: { ...model, search: { ...model.search, text, version } }, commands: [WaitSearchDebounce({ version })] }
}

export const update = SessionsComposition.makeUpdate.withContext((context: PageContext) => {
	const query = queryOf(context.location)
	return {
		CompletedReadClock: (model, { nowMs }) => load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		SucceededFetchSessions: (model, { key, data, fetchedAtMs }) => {
			const isCurrent = model.sessions.key === key
			const sessions = accept(model.sessions, key, Result.succeed(data), fetchedAtMs)
			const sessionsUpdatedAtMs = isCurrent ? fetchedAtMs : model.sessionsUpdatedAtMs
			const next = { model: settleRefresh({ ...model, sessions, sessionsUpdatedAtMs }) }
			// An empty list renders `SignalEmptyState`, which reads the shared signal presence.
			return isCurrent && data.pages.every((page) => page.length === 0)
				? { ...next, outMessage: PageOutMessage.RequestedSignalPresence() }
				: next
		},
		FailedFetchSessions: (model, { key, failure }) => ({
			model: settleRefresh({ ...model, sessions: accept(model.sessions, key, Result.fail(failure)) }),
		}),
		ClickedLoadMore: (model) => loadMore(model, context),
		SucceededFetchNextPage: (model, { key, generation, page }) =>
			generation === model.pageGeneration ? { model: appendPage(model, key, page) } : { model },
		FailedFetchNextPage: (model, { key, generation, failure }) =>
			generation !== model.pageGeneration
				? { model }
				: { model: { ...model, isFetchingNextPage: false, sessions: accept(model.sessions, key, Result.fail(failure)) } },
		SucceededFetchFacets: (model, { key, facets, fetchedAtMs }) => ({
			model: settleRefresh({ ...model, facets: accept(model.facets, key, Result.succeed(facets), fetchedAtMs) }),
		}),
		FoundCachedSessions: (model, { key, cached }) => {
			if (model.sessions.key !== key) return { model }
			const next = { ...model, sessions: acceptCached(model.sessions, key, cached, cached.isFresh), sessionsUpdatedAtMs: cached.updatedAtMs }
			const step = { model: settleRefresh(next), commands: fetchAfterCache(next, context, "sessions", cached.isFresh) }
			// A cached empty list renders `SignalEmptyState` as a fetched one does.
			const isEmpty = Option.exists(AsyncData.getData(next.sessions.data), (data) => data.pages.every((page) => page.length === 0))
			return isEmpty ? { ...step, outMessage: PageOutMessage.RequestedSignalPresence() } : step
		},
		FoundCachedFacets: (model, { key, cached }) => {
			if (model.facets.key !== key) return { model }
			const next = { ...model, facets: acceptCached(model.facets, key, cached, cached.isFresh) }
			return { model: settleRefresh(next), commands: fetchAfterCache(next, context, "facets", cached.isFresh) }
		},
		FailedFetchFacets: (model, { key, failure }) => ({
			model: settleRefresh({ ...model, facets: accept(model.facets, key, Result.fail(failure)) }),
		}),
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
		ChangedSearch: (model, { text }) => typed(model, text),
		ClickedClearSearch: (model) => typed(model, ""),
		ElapsedSearchDebounce: (model, { version }) => {
			if (version !== model.search.version) return { model }
			const trimmed = model.search.text.trim()
			return navigate({ ...model, search: { ...model.search, sent: trimmed } }, context, { q: trimmed === "" ? null : trimmed })
		},
		ToggledErrorsOnly: (model) => navigate(model, context, { errors: filtersOf(query).errorsOnly === true ? null : "1" }),
		ToggledFacetOption: (model, { param, name }) => navigate(model, context, { [param]: query.get(param) === name ? null : name }),
		ClickedClearFilters: (model) => navigate(model, context, SIDEBAR_FILTERS),
		ClickedClearAllFilters: (model) => navigate(model, context, { ...SIDEBAR_FILTERS, q: null }),
		ChangedRange: (model, { range }) => setRange(model, context, range),
		ClickedWidenRange: (model) => setRange(model, context, WIDEST_RANGE),
		InformedOfLocationChange: (model) => locationChanged(model, context),
	}
})
