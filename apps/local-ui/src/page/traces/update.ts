import { snapToMinute, WIDEST_RANGE } from "../../lib/time"
import { formatCompact, parseRange } from "@maple/web/ui/filters/range-format"
import { Option, Result } from "effect"
import { AsyncData } from "foldkit"
import { accept, acceptCached, canExtend, idle } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams, withParams } from "../contract"
import {
	FetchNextPage,
	ReadClock,
	ReadRefreshClock,
	type TracesCommand,
	WaitDurationDebounce,
	WaitSearchDebounce,
} from "./command"
import { TracesComposition } from "./composition"
import { nextCursor } from "./fetch-traces"
import { clearedFilters, filtersOf } from "./filters"
import { boundsOf, fetchAfterCache, load } from "./load"
import type { Model, TraceRow } from "./model"

export type UpdateReturn = Readonly<{
	model: Model
	commands?: ReadonlyArray<TracesCommand>
	outMessage?: PageOutMessage
}>
/** The page's own fields; the filter sections and copy buttons are assembled by their Bindings. */
type PageFields = Omit<Model, "sections" | "endpointCopy" | "envCopy">

/** The draft formatted from the committed range, as `RangeFilterSection` seeds and re-syncs it. */
const durationDraftOf = (query: URLSearchParams, version: number): Model["duration"] => {
	const { minDurationMs, maxDurationMs } = filtersOf(query)
	return {
		min: formatCompact(minDurationMs, "ms"),
		max: formatCompact(maxDurationMs, "ms"),
		version,
		minValue: minDurationMs ?? null,
		maxValue: maxDurationMs ?? null,
	}
}

const syncDuration = (duration: Model["duration"], query: URLSearchParams): Model["duration"] => {
	const { minDurationMs, maxDurationMs } = filtersOf(query)
	return (minDurationMs ?? null) === duration.minValue && (maxDurationMs ?? null) === duration.maxValue
		? duration
		: durationDraftOf(query, duration.version)
}

export const init = TracesComposition.makeInit((context: PageContext) => {
	const query = queryOf(context.location)
	const q = query.get("q") ?? ""
	const model: PageFields = {
		_tag: "TracesPage",
		maybeAnchorMs: Option.none(),
		nowMs: 0,
		traces: idle(),
		facets: idle(),
		isFetchingNextPage: false,
		pageGeneration: 0,
		tracesUpdatedAtMs: 0,
		search: { text: q, version: 0, sent: q },
		duration: durationDraftOf(query, 0),
		isRefreshing: false,
	}
	return { model, commands: [ReadClock()] }
})

/**
 * The hash changed under the page: keep the search input in sync unless the change is the page's
 * own debounced search echoing back, then request what the new filters need.
 */
const locationChanged = (model: Model, context: PageContext): UpdateReturn => {
	const query = queryOf(context.location)
	const q = query.get("q") ?? ""
	const search = q === model.search.sent ? model.search : { ...model.search, text: q, sent: q }
	return load({ ...model, search, duration: syncDuration(model.duration, query) }, context)
}

const navigate = (model: Model, context: PageContext, updates: Record<string, string | null>): UpdateReturn => ({
	model,
	outMessage: replaceParams(context.location, updates),
})

/** `setRange`: remember it for pages opened without one, then put it in the hash. */
const setRange = (model: Model, context: PageContext, range: string): UpdateReturn => ({
	model,
	outMessage: PageOutMessage.RememberedRange({ range, hash: withParams(context.location, { range }) }),
})

/** `emit` + `onRangeChange`: a reversed pair is a typo, so it is swapped; values are rounded. */
const commitDuration = (model: Model, context: PageContext, min: number | undefined, max: number | undefined) => {
	const [low, high] = min !== undefined && max !== undefined && min > max ? [max, min] : [min, max]
	return navigate(model, context, {
		minDur: low === undefined ? null : String(Math.round(low)),
		maxDur: high === undefined ? null : String(Math.round(high)),
	})
}

/** The refresh spinner stops once nothing the refresh started is still loading. */
const settleRefresh = (model: Model): Model => {
	const isLoading = (data: AsyncData.AsyncData<unknown, unknown>) =>
		AsyncData.isLoading(data) || AsyncData.isRefreshing(data)
	return model.isRefreshing && !isLoading(model.traces.data) && !isLoading(model.facets.data)
		? { ...model, isRefreshing: false }
		: model
}

/** `fetchNextPage`: the cursor after the last loaded page. */
const loadMore = (model: Model, context: PageContext): UpdateReturn => {
	const maybeNext = Option.flatMap(AsyncData.getData(model.traces.data), (data) =>
		Option.fromNullishOr(data.hasNextPage ? nextCursor(data.pages[data.pages.length - 1] ?? []) : undefined),
	)
	const maybeBounds = boundsOf(model, context)
	if (model.isFetchingNextPage || !canExtend(model.traces) || model.traces.key === null || Option.isNone(maybeNext) || Option.isNone(maybeBounds))
		return { model }
	return {
		model: { ...model, isFetchingNextPage: true },
		commands: [
			FetchNextPage({
				key: model.traces.key,
				generation: model.pageGeneration,
				search: context.location.search,
				...maybeBounds.value,
				apiBase: context.env.apiBase,
				cursorTimestamp: maybeNext.value.timestamp,
				cursorTraceId: maybeNext.value.traceId,
				pages: Option.match(AsyncData.getData(model.traces.data), { onNone: () => [], onSome: (data) => data.pages }),
			}),
		],
	}
}

/** `fetchNextPage` landed: the page joins the list if it is still the same query. */
const appendPage = (model: Model, key: string, page: ReadonlyArray<TraceRow>): Model => {
	if (model.traces.key !== key) return model
	const data = Option.map(AsyncData.getData(model.traces.data), (current) => ({
		pages: [...current.pages, page],
		hasNextPage: nextCursor(page) !== undefined,
	}))
	return Option.match(data, {
		onNone: () => ({ ...model, isFetchingNextPage: false }),
		onSome: (next) => ({ ...model, isFetchingNextPage: false, traces: { ...model.traces, key, data: AsyncData.Success({ data: next }), isPlaceholder: false } }),
	})
}

export const update = TracesComposition.makeUpdate.withContext((context: PageContext) => {
	const query = queryOf(context.location)
	const filters = filtersOf(query)
	return {
		CompletedReadClock: (model, { nowMs }) =>
			load({ ...model, nowMs, maybeAnchorMs: Option.some(snapToMinute(nowMs)) }, context),
		SucceededFetchTraces: (model, { key, data, fetchedAtMs }) => {
			const isCurrent = model.traces.key === key
			const traces = accept(model.traces, key, Result.succeed(data), fetchedAtMs)
			const tracesUpdatedAtMs = isCurrent ? fetchedAtMs : model.tracesUpdatedAtMs
			const next = { model: settleRefresh({ ...model, traces, tracesUpdatedAtMs }) }
			// An empty list renders `SignalEmptyState`, which reads the shared signal presence.
			return isCurrent && data.pages.every((page) => page.length === 0)
				? { ...next, outMessage: PageOutMessage.RequestedSignalPresence() }
				: next
		},
		FoundCachedTraces: (model, { key, cached }) => {
			if (model.traces.key !== key) return { model }
			const next = { ...model, traces: acceptCached(model.traces, key, cached, cached.isFresh), tracesUpdatedAtMs: cached.updatedAtMs }
			const step = { model: settleRefresh(next), commands: fetchAfterCache(next, context, "traces", cached.isFresh) }
			// A cached empty list renders `SignalEmptyState` as a fetched one does.
			const isEmpty = Option.exists(AsyncData.getData(next.traces.data), (data) => data.pages.every((page) => page.length === 0))
			return isEmpty ? { ...step, outMessage: PageOutMessage.RequestedSignalPresence() } : step
		},
		FoundCachedFacets: (model, { key, cached }) => {
			if (model.facets.key !== key) return { model }
			const next = { ...model, facets: acceptCached(model.facets, key, cached, cached.isFresh) }
			return { model: settleRefresh(next), commands: fetchAfterCache(next, context, "facets", cached.isFresh) }
		},
		FailedFetchTraces: (model, { key, failure }) =>
			({ model: settleRefresh({ ...model, traces: accept(model.traces, key, Result.fail(failure)) }) }),
		ClickedLoadMore: (model) => loadMore(model, context),
		SucceededFetchNextPage: (model, { key, generation, page }) =>
			generation === model.pageGeneration ? { model: appendPage(model, key, page) } : { model },
		FailedFetchNextPage: (model, { key, generation, failure }) =>
			generation !== model.pageGeneration
				? { model }
				: { model: { ...model, isFetchingNextPage: false, traces: accept(model.traces, key, Result.fail(failure)) } },
		SucceededFetchFacets: (model, { key, facets, fetchedAtMs }) =>
			({ model: settleRefresh({ ...model, facets: accept(model.facets, key, Result.succeed(facets), fetchedAtMs) }) }),
		FailedFetchFacets: (model, { key, failure }) =>
			({ model: settleRefresh({ ...model, facets: accept(model.facets, key, Result.fail(failure)) }) }),
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
		ChangedSearch: (model, { text }) => {
			const version = model.search.version + 1
			return { model: { ...model, search: { ...model.search, text, version } }, commands: [WaitSearchDebounce({ version })] }
		},
		ClickedClearSearch: (model) => {
			const version = model.search.version + 1
			return { model: { ...model, search: { ...model.search, text: "", version } }, commands: [WaitSearchDebounce({ version })] }
		},
		ElapsedSearchDebounce: (model, { version }) => {
			if (version !== model.search.version) return { model }
			const trimmed = model.search.text.trim()
			return navigate({ ...model, search: { ...model.search, sent: trimmed } }, context, { q: trimmed === "" ? null : trimmed })
		},
		ToggledErrorsOnly: (model) => navigate(model, context, { errors: filters.errorsOnly === true ? null : "1" }),
		ToggledFacetOption: (model, { param, name }) => navigate(model, context, { [param]: query.get(param) === name ? null : name }),
		ChangedDurationDraft: (model, { min, max }) => {
			const version = model.duration.version + 1
			return {
				model: { ...model, duration: { ...model.duration, min, max, version } },
				commands: [WaitDurationDebounce({ version })],
			}
		},
		ElapsedDurationDebounce: (model, { version }) =>
			version !== model.duration.version
				? { model }
				: commitDuration(model, context, parseRange(model.duration.min, "ms"), parseRange(model.duration.max, "ms")),
		CommittedDurationDraft: (model) => {
			const min = parseRange(model.duration.min, "ms")
			const max = parseRange(model.duration.max, "ms")
			const duration = { ...model.duration, version: model.duration.version + 1, min: formatCompact(min, "ms"), max: formatCompact(max, "ms") }
			return commitDuration({ ...model, duration }, context, min, max)
		},
		AppliedDuration: (model, { min, max }) => {
			const duration = { ...model.duration, version: model.duration.version + 1, min: formatCompact(min ?? undefined, "ms"), max: formatCompact(max ?? undefined, "ms") }
			return commitDuration({ ...model, duration }, context, min ?? undefined, max ?? undefined)
		},
		ClickedClearFilters: (model) => navigate(model, context, clearedFilters()),
		ClickedExitSpanScope: (model) => navigate(model, context, { scope: null }),
		ChangedRange: (model, { range }) => setRange(model, context, range),
		ClickedWidenRange: (model) => setRange(model, context, WIDEST_RANGE),
		InformedOfLocationChange: (model) => locationChanged(model, context),
	}
})
