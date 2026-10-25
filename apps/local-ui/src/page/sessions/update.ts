import type { Resources } from "../../platform/resources"
import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import * as FilterSections from "@maple/web/ui/filters/filter-sections"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import { accept, acceptCached, idle } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage } from "../contract"
import { updateCopy } from "../kit/copies"
import { ReadClock, ReadRefreshClock, WaitSearchDebounce } from "./command"
import { filtersOf } from "./fetch"
import { fetchAfterCache, load } from "./load"
import { Message } from "./message"
import type { Model } from "./model"
import { appendPage, loadMore, navigate, setRange, settleRefresh, type UpdateReturn } from "./update-helpers"

export type { UpdateReturn } from "./update-helpers"

const toSections = (message: FilterSections.Message) => Message.GotFilterSectionsMessage({ message })

const SIDEBAR_FILTERS = { service: null, browser: null, device: null, errors: null }

export const init = (context: PageContext): Readonly<{ model: Model; commands: ReadonlyArray<Command.Command<Message, never, Resources>> }> => {
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
			sections: FilterSections.init(),
			isRefreshing: false,
			copies: {},
		},
		commands: [ReadClock(), Command.mapMessage(FilterSections.ReadRemembered(), toSections)],
	}
}

/** The hash changed: keep the search input in sync unless it is the page's own echo, then load. */
export const locationChanged = (model: Model, context: PageContext): UpdateReturn => {
	const q = queryOf(context.location).get("q") ?? ""
	const search = q === model.search.sent ? model.search : { ...model.search, text: q, sent: q }
	return load({ ...model, search }, context)
}

const typed = (model: Model, text: string): UpdateReturn => {
	const version = model.search.version + 1
	return { model: { ...model, search: { ...model.search, text, version } }, commands: [WaitSearchDebounce({ version })] }
}

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn => {
	const query = queryOf(context.location)
	return Message.match<UpdateReturn>(message, {
		CompletedReadClock: ({ nowMs }) => load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		SucceededFetchSessions: ({ key, data, fetchedAtMs }) => {
			const isCurrent = model.sessions.key === key
			const sessions = accept(model.sessions, key, Result.succeed(data), fetchedAtMs)
			const sessionsUpdatedAtMs = isCurrent ? fetchedAtMs : model.sessionsUpdatedAtMs
			const next = { model: settleRefresh({ ...model, sessions, sessionsUpdatedAtMs }) }
			// An empty list renders `SignalEmptyState`, which reads the shared signal presence.
			return isCurrent && data.pages.every((page) => page.length === 0)
				? { ...next, outMessage: PageOutMessage.RequestedSignalPresence() }
				: next
		},
		FailedFetchSessions: ({ key, failure }) => ({
			model: settleRefresh({ ...model, sessions: accept(model.sessions, key, Result.fail(failure)) }),
		}),
		ClickedLoadMore: () => loadMore(model, context),
		SucceededFetchNextPage: ({ key, generation, page }) =>
			generation === model.pageGeneration ? { model: appendPage(model, key, page) } : { model },
		FailedFetchNextPage: ({ key, generation, failure }) =>
			generation !== model.pageGeneration
				? { model }
				: { model: { ...model, isFetchingNextPage: false, sessions: accept(model.sessions, key, Result.fail(failure)) } },
		SucceededFetchFacets: ({ key, facets, fetchedAtMs }) => ({
			model: settleRefresh({ ...model, facets: accept(model.facets, key, Result.succeed(facets), fetchedAtMs) }),
		}),
		FoundCachedSessions: ({ key, cached }) => {
			if (model.sessions.key !== key) return { model }
			const next = { ...model, sessions: acceptCached(model.sessions, key, cached, cached.isFresh), sessionsUpdatedAtMs: cached.updatedAtMs }
			const step = { model: settleRefresh(next), commands: fetchAfterCache(next, context, "sessions", cached.isFresh) }
			// A cached empty list renders `SignalEmptyState` as a fetched one does.
			const isEmpty = Option.exists(AsyncData.getData(next.sessions.data), (data) => data.pages.every((page) => page.length === 0))
			return isEmpty ? { ...step, outMessage: PageOutMessage.RequestedSignalPresence() } : step
		},
		FoundCachedFacets: ({ key, cached }) => {
			if (model.facets.key !== key) return { model }
			const next = { ...model, facets: acceptCached(model.facets, key, cached, cached.isFresh) }
			return { model: settleRefresh(next), commands: fetchAfterCache(next, context, "facets", cached.isFresh) }
		},
		FailedFetchFacets: ({ key, failure }) => ({
			model: settleRefresh({ ...model, facets: accept(model.facets, key, Result.fail(failure)) }),
		}),
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
		ChangedSearch: ({ text }) => typed(model, text),
		ClickedClearSearch: () => typed(model, ""),
		ElapsedSearchDebounce: ({ version }) => {
			if (version !== model.search.version) return { model }
			const trimmed = model.search.text.trim()
			return navigate({ ...model, search: { ...model.search, sent: trimmed } }, context, { q: trimmed === "" ? null : trimmed })
		},
		ToggledErrorsOnly: () => navigate(model, context, { errors: filtersOf(query).errorsOnly === true ? null : "1" }),
		ToggledFacetOption: ({ param, name }) => navigate(model, context, { [param]: query.get(param) === name ? null : name }),
		ClickedClearFilters: () => navigate(model, context, SIDEBAR_FILTERS),
		ClickedClearAllFilters: () => navigate(model, context, { ...SIDEBAR_FILTERS, q: null }),
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
