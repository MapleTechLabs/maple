import { Array as Arr, Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { resolveWindow, type TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { type PageContext, PageOutMessage, type PageReturn, pickCommands } from "../../contract"
import { SignalPresenceData } from "../../kit/signal-presence"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CompleteReloadSpin,
	FetchFacets,
	FetchFirstPage,
	FetchNextPage,
	listInput,
	LoadSignalPresence,
	PAGE_SIZE,
	ResolveWindow,
} from "./command"
import type { Search } from "./derive"
import { sidebarHandlers, tableHandlers } from "./handlers"
import * as Dialog from "../../../ui/dialog"
import { advancedDialogStep, advancedHandlers, openedAdvanced } from "./advanced"
import { initAdvanced } from "./advanced-model"
import {
	openPeekedTrace,
	peekDialogStep,
	peekRow,
	peekStep,
	steppedPeek,
	syncPeek,
	traceHrefFrom,
} from "./peek"
import { Message, type RequestMode } from "./message"
import type { Model, Pagination, TraceRow } from "./model"
import { durationDraftOf } from "./search-edits"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

export const DEFAULT_PRESET = "12h"
/** `useInfiniteTraces`: rows kept across pages, and rows from the end that ask for the next page. */
export const MAX_RETAINED_TRACES = 2_000
const FETCH_THRESHOLD = 20

// ROWS

/** `allData`: the first page then every later one, capped. */
export const allRows = (model: Model): ReadonlyArray<TraceRow> => {
	const first = AsyncData.getData(model.firstPage.data)
	return Option.isNone(first)
		? []
		: [...first.value.rows, ...model.pagination.pages.flatMap((page) => page.rows)].slice(
				0,
				MAX_RETAINED_TRACES,
			)
}

export const hiddenCount = (model: Model): number =>
	Option.match(AsyncData.getData(model.firstPage.data), {
		onNone: () => 0,
		onSome: (first) =>
			first.hiddenCount + model.pagination.pages.reduce((sum, page) => sum + page.hiddenCount, 0),
	})

/** More pages exist when the last warehouse page came back full before the noise filter. */
export const hasNextPage = (model: Model): boolean => {
	if (allRows(model).length >= MAX_RETAINED_TRACES || model.pagination.isStopped) return false
	const first = AsyncData.getData(model.firstPage.data)
	if (Option.isNone(first) || AsyncData.isFailure(model.firstPage.data)) return false
	const last = Arr.last(model.pagination.pages)
	return (
		Option.getOrElse(
			Option.map(last, (page) => page.scannedCount),
			() => first.value.scannedCount,
		) === PAGE_SIZE
	)
}

// REQUESTS

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode): Cmd =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const firstPageKey = (model: Model, context: PageContext, window: TimeWindow) =>
	requestKey(context.orgId, "listTraces", {
		data: listInput(model.search, window, context.pinnedNamespace, 0),
	})

const freshPagination = (key: string | null, generation: number): Pagination => ({
	key,
	generation,
	pages: [],
	isFetching: false,
	isStopped: false,
})

const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const facetsKey = requestKey(context.orgId, "getTracesFacets", { data: window })
	const listKey = firstPageKey(model, context, window)
	// Reload refreshes the table (`useTableRefreshTimeRange`); the facet atom is not refreshed.
	const facets = Keyed.request(model.facets, facetsKey, "Load")
	const cached =
		mode === "Load" && model.firstPage.key !== listKey ? model.firstPageCache[listKey] : undefined
	const firstPage =
		cached === undefined
			? Keyed.request(model.firstPage, listKey, mode)
			: Option.none<Model["firstPage"]>()
	const commands: ReadonlyArray<Cmd> = [
		...(Option.isSome(facets) ? [FetchFacets({ key: facetsKey, window })] : []),
		...(Option.isSome(firstPage)
			? [
					FetchFirstPage({
						key: listKey,
						search: model.search,
						window,
						pinnedNamespace: context.pinnedNamespace,
					}),
				]
			: []),
	]
	return {
		model: {
			...model,
			window,
			facets: Option.getOrElse(facets, () => model.facets),
			firstPage:
				cached === undefined
					? Option.getOrElse(firstPage, () => model.firstPage)
					: { key: listKey, data: AsyncData.Success({ data: cached }) },
			pagination:
				model.pagination.key === listKey
					? model.pagination
					: freshPagination(listKey, model.pagination.generation + 1),
		},
		commands,
	}
}

const nextOffset = (pagination: Pagination): number => (pagination.pages.length + 1) * PAGE_SIZE

/** `useVirtualReachEnd`: the rendered window nears the end of the loaded rows. */
const reachEnd = (model: Model, context: PageContext): Return => {
	const lastIndex = Option.getOrElse(
		Option.map(Arr.last(model.virtualRows), (row) => row.index),
		() => -1,
	)
	const count = allRows(model).length
	const { window, pagination } = model
	if (
		lastIndex < 0 ||
		window === null ||
		pagination.key === null ||
		pagination.isFetching ||
		!hasNextPage(model) ||
		lastIndex < count - FETCH_THRESHOLD
	)
		return { model }
	return {
		model: { ...model, pagination: { ...pagination, isFetching: true } },
		commands: [
			FetchNextPage({
				key: pagination.key,
				search: model.search,
				window,
				pinnedNamespace: context.pinnedNamespace,
				offset: nextOffset(pagination),
				generation: pagination.generation,
			}),
		],
	}
}

const navigate = (model: Model, search: Search, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOf(AppRoute.Traces({ search })), isReplace }),
})

// ENTRY POINTS

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		windowZone: null,
		nowMs: 0,
		facets: Keyed.idle(),
		firstPage: Keyed.idle(),
		pagination: freshPagination(null, 0),
		firstPageCache: {},
		virtualRows: [],
		totalSize: 0,
		presence: SignalPresenceData.Loading(),
		filterSections: FilterSections.init(),
		timePicker: TimeRangePicker.init("traces-time-range"),
		durationDraft: durationDraftOf(route.search),
		durationDraftVersion: 0,
		refreshVersion: 0,
		isReloading: false,
		focusedIndex: null,
		peekDialog: Dialog.init("traces-peek", "sheet"),
		peek: null,
		advanced: initAdvanced(),
	}
	const peeked = syncPeek(model, context)
	return {
		...peeked,
		commands: [
			LoadSignalPresence({ orgId: context.orgId }),
			resolveCommand(model, context, "Load"),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
			...(peeked.commands ?? []),
		],
	}
}

/** The search without the peek params: only these re-query the list. */
const listSearchOf = (search: Search): Search => ({
	...search,
	peek: undefined,
	peekRow: undefined,
	peekT: undefined,
	peekSpan: undefined,
})

const searchHref = (search: Search) => hrefOf(AppRoute.Traces({ search }))

/** The route loader warms only the facet sidebar (`getTracesFacetsResultAtom`) for the snapped window. */
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
	return pickCommands(requestAll(model, context, window, "Load"), [FetchFacets.name])
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	if (searchHref(listSearchOf(model.search)) === searchHref(listSearchOf(route.search)))
		return syncPeek({ ...model, search: route.search }, context)
	const isSameDuration =
		route.search.minDurationMs === model.search.minDurationMs &&
		route.search.maxDurationMs === model.search.maxDurationMs
	const next: Model = {
		...model,
		search: route.search,
		durationDraft: isSameDuration ? model.durationDraft : durationDraftOf(route.search),
	}
	const resolve = (): Return => ({
		model: next,
		commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
	})
	return routeWindowStep(model.search, route.search, {
		resolve,
		requestAll: (mode) =>
			next.window === null ? resolve() : requestAll(next, context, next.window, mode),
	})
}

/** A pin re-requests the same window; a new zone re-resolves it, as "today" moves. */
export const contextChanged = (model: Model, context: PageContext): Return => {
	if (model.window === null) return { model }
	if (model.windowZone !== null && model.windowZone !== context.timeZone)
		return {
			model,
			commands: [resolveCommand(model, context, model.refreshVersion === 0 ? "Load" : "Refresh")],
		}
	return requestAll(model, context, model.window, "Load")
}

const lift = <A>(
	model: Model,
	commands: ReadonlyArray<Command.Command<A, never, Resources>> | undefined,
	wrap: (inner: A) => Message,
	patch: Partial<Model>,
): Return => ({
	model: { ...model, ...patch },
	commands: Command.mapMessages(commands ?? [], wrap),
})

/** A settled first page or later page, then the reach-end check `useVirtualReachEnd` re-runs. */
const settled = (model: Model, context: PageContext): Return => reachEnd(model, context)

/** `onTraceClick` below `md`: the row's trace page, keeping the list's search. */
const openRow = (model: Model, index: number): Return => {
	const row = allRows(model)[index]
	return row === undefined
		? { model }
		: {
				model,
				outMessage: PageOutMessage.RequestedNavigation({
					url: traceHrefFrom(
						model.search,
						row.traceId,
						row.startTime,
						row.isRootSpan ? undefined : row.spanId,
					),
					isReplace: false,
				}),
			}
}

/** `useListNavigation` over the rows, and the peek's own keys while it is open. */
const pressedListKey = (model: Model, key: string, isMobile: boolean, context: PageContext): Return => {
	const isDown = key === "j" || key === "J" || key === "ArrowDown"
	const isUp = key === "k" || key === "K" || key === "ArrowUp"
	if (model.search.peek !== undefined && !isMobile) {
		if (isDown || isUp) return steppedPeek(model, isDown ? 1 : -1)
		return key === "Enter" ? openPeekedTrace(model) : { model }
	}
	const count = allRows(model).length
	if ((isDown || isUp) && count > 0) {
		const current = model.focusedIndex ?? -1
		const next = isDown
			? current < 0
				? 0
				: Math.min(current + 1, count - 1)
			: current <= 0
				? 0
				: current - 1
		return { model: { ...model, focusedIndex: next } }
	}
	if (key === "Enter" && model.focusedIndex !== null)
		return isMobile ? openRow(model, model.focusedIndex) : peekRow(model, model.focusedIndex)
	if (key === "Escape") return { model: { ...model, focusedIndex: null } }
	if (key === "f" || key === "F") return openedAdvanced(model, context)
	return { model }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode, timeZone }) =>
			requestAll({ ...model, nowMs, windowZone: timeZone }, context, window, mode),
		CompletedFetchFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		CompletedFetchFirstPage: ({ key, result }) => {
			const firstPage = Keyed.accept(model.firstPage, key, result)
			const firstPageCache = Result.match(result, {
				onSuccess: (page) =>
					firstPage === model.firstPage
						? model.firstPageCache
						: { ...model.firstPageCache, [key]: page },
				onFailure: () => model.firstPageCache,
			})
			const done = settled({ ...model, firstPage, firstPageCache }, context)
			// A peek whose row just loaded gains the row's time (`resolvePeek`).
			const peeked = syncPeek(done.model, context)
			return { ...peeked, commands: [...(done.commands ?? []), ...(peeked.commands ?? [])] }
		},
		// Accepted only for the exact request it answers: the key, its set of pages and the offset.
		CompletedFetchNextPage: ({ key, generation, offset, result }) => {
			const { pagination: current } = model
			if (
				key !== current.key ||
				generation !== current.generation ||
				!current.isFetching ||
				offset !== nextOffset(current)
			)
				return { model }
			const pagination: Pagination = Result.match(result, {
				onSuccess: (page) => ({
					...model.pagination,
					pages: [...model.pagination.pages, page],
					isFetching: false,
				}),
				// A failed page ends pagination, so the list stops asking (a backend offset cap).
				onFailure: () => ({ ...model.pagination, isFetching: false, isStopped: true }),
			})
			return settled({ ...model, pagination }, context)
		},
		ChangedVirtualWindow: ({ rows, totalSize }) =>
			reachEnd({ ...model, virtualRows: rows, totalSize }, context),
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
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		ClickedClearNamespacePin: () => ({
			model,
			outMessage: PageOutMessage.RequestedNamespacePin({ maybeNamespace: Option.none() }),
		}),
		...sidebarHandlers(model),
		...tableHandlers(model),
		ClickedPeekRow: ({ index }) => peekRow(model, index),
		ClickedAdvancedFilter: () => openedAdvanced(model, context),
		GotAdvancedDialogMessage: ({ message: inner }) => advancedDialogStep(model, inner),
		...advancedHandlers(model),
		ClickedPeekStep: ({ step }) => steppedPeek(model, step),
		ClickedOpenTrace: () => openPeekedTrace(model),
		PressedListKey: ({ key, isMobile }) => pressedListKey(model, key, isMobile, context),
		PressedOpenRow: ({ index }) => openRow(model, index),
		GotPeekMessage: ({ message: inner }) => peekStep(model, inner, context),
		GotPeekDialogMessage: ({ message: inner }) => peekDialogStep(model, inner),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return lift(model, next.commands, (m) => Message.GotFilterSectionsMessage({ message: m }), {
				filterSections: next.model,
			})
		},
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
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
		},
	})
