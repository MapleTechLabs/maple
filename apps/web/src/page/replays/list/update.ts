import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { resolveWindow, type TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { parseRange } from "../../../ui/filters/range-format"
import { HistogramMessage } from "../../../ui/filters/range-histogram"
import { type PageContext, PageOutMessage, type PageReturn, pickCommands } from "../../contract"
import { SignalPresenceData } from "../../kit/signal-presence"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CompleteReloadSpin,
	DebounceDraft,
	DebounceQuery,
	FetchFacets,
	FetchFirstPage,
	FetchNextPage,
	filterInputs,
	LoadSignalPresence,
	PAGE_SIZE,
	ResolveWindow,
} from "./command"
import { emptyWindow } from "../kit/virtualize"
import { draftOf, nextCursor } from "./derive"
import { Message, type Range, type RequestMode } from "./message"
import type { Model, Pagination, ReplaysPage, Search } from "./model"
import {
	addedRowTag,
	clearedFilters,
	clearedSidebar,
	textValue,
	toggledEngaged,
	toggledFacet,
	toggledTag,
	withRange,
} from "./search-edits"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

export const DEFAULT_PRESET = "24h"

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode): Cmd =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const freshPagination = (key: string | null, generation: number): Pagination => ({
	key,
	generation,
	pages: [],
	isFetching: false,
	isStopped: false,
})

const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const inputs = filterInputs(model.search, window)
	const listKey = requestKey(context.orgId, "listReplays", { data: { ...inputs, limit: PAGE_SIZE } })
	const facetsKey = requestKey(context.orgId, "getReplaysFacets", { data: inputs })
	const firstPage = Keyed.request(model.firstPage, listKey, mode)
	const facets = Keyed.request(model.facets, facetsKey, mode)
	const args = { search: model.search, window }
	return {
		model: {
			...model,
			window,
			firstPage: Option.getOrElse(firstPage, () => model.firstPage),
			facets: Option.getOrElse(facets, () => model.facets),
			pagination:
				model.pagination.key === listKey && mode === "Load"
					? model.pagination
					: freshPagination(listKey, model.pagination.generation + 1),
		},
		commands: [
			...(Option.isSome(firstPage) ? [FetchFirstPage({ key: listKey, ...args, refresh: mode === "Refresh" })] : []),
			...(Option.isSome(facets) ? [FetchFacets({ key: facetsKey, ...args, refresh: mode === "Refresh" })] : []),
		],
	}
}

/** `use-infinite-replays`: a server repeating an earlier cursor would loop, so paging stops. */
const isRepeatedCursor = (model: Model, page: ReplaysPage): boolean =>
	page.hasMore &&
	page.nextCursor !== null &&
	(page.nextCursor === Option.getOrUndefined(AsyncData.getData(model.firstPage.data))?.nextCursor ||
		model.pagination.pages.some((earlier) => earlier.nextCursor === page.nextCursor))

/** The sentinel or Load more asks for the next page; one in flight at a time. */
const fetchNext = (model: Model): Return => {
	const cursor = nextCursor(model)
	const { pagination, window } = model
	// Page 2 follows the current key's settled first page, never the previous one still on screen.
	const isFirstPageCurrent = pagination.pages.length > 0 || AsyncData.isSuccess(model.firstPage.data)
	if (cursor === null || !isFirstPageCurrent || window === null || pagination.key === null || pagination.isFetching)
		return { model }
	return {
		model: { ...model, pagination: { ...pagination, isFetching: true } },
		commands: [FetchNextPage({ key: pagination.key, search: model.search, window, cursor, generation: pagination.generation })],
	}
}

export const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOf(AppRoute.Replays({ search })), isReplace: false }),
})

const searchHref = (search: Search) => hrefOf(AppRoute.Replays({ search }))

// ENTRY POINTS

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const { search } = route
	const model: Model = {
		search,
		window: null,
		nowMs: 0,
		firstPage: Keyed.idle(),
		pagination: freshPagination(null, 0),
		facets: Keyed.idle(),
		expandedRuns: [],
		virtualWindow: emptyWindow,
		presence: SignalPresenceData.Loading(),
		query: search.q ?? "",
		queryGeneration: 0,
		userText: search.user ?? "",
		userIdText: search.userId ?? "",
		durationDraft: draftOf(search.durationMin, search.durationMax),
		activeDraft: draftOf(search.activeMin, search.activeMax),
		histogramHover: {},
		draftVersion: 0,
		filterSections: FilterSections.init(),
		timePicker: TimeRangePicker.init("replays-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			LoadSignalPresence({ orgId: context.orgId }),
			resolveCommand(model, context, "Load"),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
		],
	}
}

/** A new search: inputs keyed on the URL value (text filters, the toolbar search) resync. */
/** The route loader warms the first page and the facets (`listReplaysResultAtom`, `replaysFacetsResultAtom`). */
export const preload = (route: { readonly search: Search }, context: PageContext, nowMs: number) => {
	const { model } = init(route, context)
	const window = resolveWindow(
		{
			startTime: model.search.startTime,
			endTime: model.search.endTime,
			preset: model.search.timePreset ?? DEFAULT_PRESET,
			snap: true,
			timeZone: context.timeZone,
		},
		nowMs,
	)
	return pickCommands(requestAll(model, context, window, "Load"), [FetchFirstPage.name, FetchFacets.name])
}

export const routeChanged = (model: Model, route: { readonly search: Search }, context: PageContext): Return => {
	const { search } = route
	if (searchHref(model.search) === searchHref(search)) return { model }
	const previous = model.search
	const next: Model = {
		...model,
		search,
		query: textValue(model.query) === search.q ? model.query : (search.q ?? ""),
		userText: previous.user === search.user ? model.userText : (search.user ?? ""),
		userIdText: previous.userId === search.userId ? model.userIdText : (search.userId ?? ""),
		durationDraft:
			previous.durationMin === search.durationMin && previous.durationMax === search.durationMax
				? model.durationDraft
				: draftOf(search.durationMin, search.durationMax),
		activeDraft:
			previous.activeMin === search.activeMin && previous.activeMax === search.activeMax
				? model.activeDraft
				: draftOf(search.activeMin, search.activeMax),
	}
	const resolve = (): Return => ({ model: next, commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))] })
	return routeWindowStep(previous, search, {
		resolve,
		requestAll: (mode) =>
			next.window === null ? resolve() : requestAll(next, context, next.window, mode),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.window === null ? { model } : requestAll(model, context, model.window, "Load")

const draftOfRange = (model: Model, range: Range) =>
	range === "duration" ? model.durationDraft : model.activeDraft

/** Commits a typed range; on blur and Enter the fields are rewritten in canonical form. */
const commitDraft = (model: Model, range: Range, isRewrite = true): Return => {
	const draft = draftOfRange(model, range)
	const committed = withRange(model.search, range, parseRange(draft.min, "s"), parseRange(draft.max, "s"))
	if (!isRewrite) return searchHref(committed) === searchHref(model.search) ? { model } : navigate(model, committed)
	const canonical = draftOf(
		range === "duration" ? committed.durationMin : committed.activeMin,
		range === "duration" ? committed.durationMax : committed.activeMax,
	)
	const next: Model = {
		...model,
		draftVersion: model.draftVersion + 1,
		...(range === "duration" ? { durationDraft: canonical } : { activeDraft: canonical }),
	}
	return searchHref(committed) === searchHref(model.search) ? { model: next } : navigate(next, committed)
}

const lift = <A>(
	model: Model,
	commands: ReadonlyArray<Command.Command<A, never, Resources>> | undefined,
	wrap: (inner: A) => Message,
	patch: Partial<Model>,
): Return => ({ model: { ...model, ...patch }, commands: Command.mapMessages(commands ?? [], wrap) })

const changedQuery = (model: Model, value: string): Return => {
	const queryGeneration = model.queryGeneration + 1
	return { model: { ...model, query: value, queryGeneration }, commands: [DebounceQuery({ generation: queryGeneration })] }
}

const pickedTime = (model: Model, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const lifted = lift(model, next.commands, (m) => Message.GotTimePickerMessage({ message: m }), {
		timePicker: next.model,
	})
	return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
		? lifted
		: {
				...lifted,
				outMessage: navigate(model, {
					...model.search,
					...TimeRangePicker.searchPatchOf(next.outMessage),
				}).outMessage,
			}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) => requestAll({ ...model, nowMs }, context, window, mode),
		CompletedFetchFirstPage: ({ key, result }) => ({
			model: { ...model, firstPage: Keyed.accept(model.firstPage, key, result) },
		}),
		// Accepted only for the exact request it answers: the key, its set of pages and the cursor.
		CompletedFetchNextPage: ({ key, generation, cursor, result }) =>
			key !== model.pagination.key ||
			generation !== model.pagination.generation ||
			!model.pagination.isFetching ||
			cursor !== nextCursor(model)
				? { model }
				: {
						model: {
							...model,
							pagination: Result.match(result, {
								onSuccess: (page) => ({
									...model.pagination,
									pages: [...model.pagination.pages, page],
									isFetching: false,
									isStopped: isRepeatedCursor(model, page),
								}),
								onFailure: () => ({ ...model.pagination, isFetching: false, isStopped: true }),
							}),
						},
					},
		CompletedFetchFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		ReachedListEnd: () => fetchNext(model),
		ChangedVirtualWindow: ({ window }) => ({ model: { ...model, virtualWindow: window } }),
		ClickedLoadMore: () => fetchNext(model),
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [
					resolveCommand(reloaded, context, "Refresh"),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedResetTimeRange: () =>
			navigate(model, { ...model.search, startTime: undefined, endTime: undefined, timePreset: DEFAULT_PRESET }),
		ClickedRetryList: () =>
			model.window === null || model.firstPage.key === null
				? { model }
				: requestAll(model, context, model.window, "Refresh"),
		ChangedQuery: ({ value }) => changedQuery(model, value),
		ClickedClearQuery: () => changedQuery(model, ""),
		CompletedQueryDebounce: ({ generation }) => {
			if (generation !== model.queryGeneration) return { model }
			const q = textValue(model.query)
			return q === model.search.q ? { model } : navigate(model, { ...model.search, q })
		},
		ToggledErrorsOnly: () =>
			navigate(model, { ...model.search, hasErrors: model.search.hasErrors === true ? undefined : true }),
		ToggledEngagedOnly: () => navigate(model, toggledEngaged(model.search)),
		ToggledTag: ({ tag }) => navigate(model, toggledTag(model.search, tag)),
		ToggledFacetOption: ({ facet, name }) => navigate(model, toggledFacet(model.search, facet, name)),
		ChangedRangeDraft: ({ range, min, max }) => ({
			model: {
				...model,
				...(range === "duration" ? { durationDraft: { min, max } } : { activeDraft: { min, max } }),
				draftVersion: model.draftVersion + 1,
			},
			commands: [DebounceDraft({ version: model.draftVersion + 1 })],
		}),
		CompletedDraftDebounce: ({ version }) => {
			if (version !== model.draftVersion) return { model }
			const duration = commitDraft(model, "duration", false)
			return duration.outMessage === undefined ? commitDraft(model, "active", false) : duration
		},
		CommittedRangeDraft: ({ range }) => commitDraft(model, range),
		AppliedRange: ({ range, min, max }) =>
			navigate({ ...model, draftVersion: model.draftVersion + 1 }, withRange(model.search, range, min, max)),
		GotHistogramMessage: ({ range, message: inner }) =>
			HistogramMessage.match<Return>(inner, {
				PointedHistogramBar: ({ index }) => ({
					model: { ...model, histogramHover: { ...model.histogramHover, [range]: index } },
				}),
				LeftHistogram: () => ({
					model: {
						...model,
						histogramHover: Object.fromEntries(
							Object.entries(model.histogramHover).filter(([key]) => key !== range),
						),
					},
				}),
				SelectedHistogramRange: ({ min, max }) =>
					navigate(
						{ ...model, draftVersion: model.draftVersion + 1 },
						withRange(model.search, range, min, max),
					),
			}),
		ChangedUserText: ({ value }) => ({ model: { ...model, userText: value } }),
		ChangedUserIdText: ({ value }) => ({ model: { ...model, userIdText: value } }),
		SubmittedUser: () => navigate(model, { ...model.search, user: textValue(model.userText) }),
		SubmittedUserId: () => navigate(model, { ...model.search, userId: textValue(model.userIdText) }),
		ClickedClearUser: () => navigate(model, { ...model.search, user: undefined }),
		ClickedClearUserId: () => navigate(model, { ...model.search, userId: undefined }),
		ClickedClearVisitor: () => navigate(model, { ...model.search, visitorId: undefined }),
		ClickedClearSidebarFilters: () => navigate(model, clearedSidebar(model.search)),
		ClickedClearFilters: () => navigate(model, clearedFilters(model.search)),
		ClickedSession: ({ sessionId, startTime }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Replay({ sessionId, search: { t: startTime } })),
				isReplace: false,
			}),
		}),
		ToggledRun: ({ key }) => ({
			model: {
				...model,
				expandedRuns: model.expandedRuns.includes(key)
					? model.expandedRuns.filter((other) => other !== key)
					: [...model.expandedRuns, key],
			},
		}),
		ClickedRowTag: ({ tag }) => navigate(model, addedRowTag(model.search, tag)),
		ClickedRowGroup: ({ group }) => navigate(model, { ...model.search, group }),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return lift(model, next.commands, (m) => Message.GotFilterSectionsMessage({ message: m }), {
				filterSections: next.model,
			})
		},
		GotTimePickerMessage: ({ message: inner }) => pickedTime(model, inner),
	})
