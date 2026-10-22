import { shortId } from "@maple/ui/lib/ids"
import { addLogAttributeFilter } from "../../../lib/logs/log-attribute-filters"
import { parseLogSearch } from "../../../lib/logs/log-search-query"
import { computeBucketSeconds } from "@maple/web-data/warehouse/timeseries-utils"
import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import * as FilterSections from "../../../ui/filters/filter-sections"
import { logTimeFormat, toLogRowView } from "../../../ui/logs/log-row-view"
import * as LogsStream from "../../../ui/logs/logs-stream"
import * as Menu from "../../../ui/menu"
import * as Popover from "../../../ui/popover"
import * as Tooltip from "../../../ui/tooltip"
import { listFooterText } from "../../../ui/logs/viewer"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as LogDetail from "../detail"
import { copyToast } from "../../kit/clipboard"
import { SignalPresenceData } from "../../kit/signal-presence"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CompleteReloadSpin,
	FetchAttributeKeys,
	FetchFacets,
	FetchFirstPage,
	FetchNextPage,
	FetchVolume,
	LoadSignalPresence,
	ReadPreferences,
	ResolveWindow,
	SavePreferences,
	WaitSearchDebounce,
} from "./command"
import {
	allLogs,
	brushRange,
	chipId,
	FETCH_THRESHOLD,
	HISTOGRAM_TARGET_POINTS,
	hasNextPage,
	lastCursor,
	listInput,
	logFilterChips,
	MAX_RETAINED_LOGS,
	type Search,
	volumeInput,
	withoutChips,
} from "./derive"
import { initSearchHelp } from "./view-search-help"
import { type Facet, Message, type RequestMode } from "./message"
import type { LogsPage, Model, Pagination } from "./model"
import type { LoadFailure } from "../../../data/load-failure"

export type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

// The preset "widen the time range" switches to.
const WIDEN_TIME_PRESET = "7d"

/** The stream's default window (`DashboardPage`'s `defaultPreset`). */
export const DEFAULT_PRESET = "12h"

const NO_BRUSH = { left: null, right: null, isSelecting: false }

const freshPagination = (generation: number): Pagination => ({
	generation,
	pages: [],
	isFetching: false,
	isStopped: false,
})

export const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

// STREAM ROWS

const firstPageOf = (model: Model) => Option.getOrUndefined(AsyncData.getData(model.firstPage.data))

/** `ListFooter`'s line: the count, scoped by the trace and the search. */
const footerOf = (model: Model, shown: number): string => {
	const scope = [
		model.search.traceId ? ` in trace ${shortId(model.search.traceId, "trace")}` : "",
		model.search.search ? ` matching “${model.search.search}”` : "",
	].join("")
	return listFooterText(model.locale, {
		shown,
		noun: `logs${scope}`,
		capped: shown >= MAX_RETAINED_LOGS,
		hasMore: hasNextPage(firstPageOf(model), model.pagination),
	})
}

export const footerText = (model: Model): string =>
	footerOf(model, allLogs(firstPageOf(model), model.pagination).length)

const rowsOf = (model: Model, context: PageContext) => {
	const time = logTimeFormat(context.timeZone)
	const pinned = model.search.columns ?? []
	return allLogs(firstPageOf(model), model.pagination).map((log) => toLogRowView(log, pinned, time))
}

const streamSlot = {
	read: (model: Model) => Option.some(model.stream),
	write: (model: Model, stream: LogsStream.Model): Model => ({ ...model, stream }),
	toParentMessage: (message: LogsStream.Message) => Message.GotStreamMessage({ message }),
}

/** New data (a reload, a filter): expansion was made on the old rows, so it goes (`expansion.anchor`). */
const replaceStreamRows = (model: Model, context: PageContext): Return => {
	const result = LogsStream.replaceRows(model.stream, rowsOf(model, context))
	return {
		model: { ...model, stream: result.model, selectedIndex: null, ...inspectOf(result.outMessage) },
		commands: Command.mapMessages(result.commands ?? [], streamSlot.toParentMessage),
	}
}

/** More of the same logs (a later page, a pinned column): expansion stays. */
const setStreamRows = (model: Model, context: PageContext): Model => ({
	...model,
	stream: LogsStream.setRows(model.stream, rowsOf(model, context)).model,
})

const inspectOf = (out: LogsStream.OutMessage | undefined): Partial<Model> =>
	out?._tag === "ChangedInspecting"
		? { isInspecting: out.isInspecting, isScrolledAway: out.isScrolledAway }
		: {}

// REQUESTS

type Step = Readonly<{ model: Model; commands: Commands }>

/** One `Keyed.request`: `Some` writes the slot and returns its fetch (S6). */
const keyed = <A, E>(
	step: Step,
	slot: (model: Model) => Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	write: (model: Model, next: Keyed.Keyed<A, E>) => Model,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): Step =>
	Option.match(Keyed.request(slot(step.model), key, mode), {
		onNone: () => step,
		onSome: (next) => ({ model: write(step.model, next), commands: [...step.commands, fetch(key)] }),
	})

/** Every query the page reads, keyed by its inputs, for the resolved window. */
/**
 * Reload refreshes only the stream (`useRefreshableAtomValue`); the other reads refetch only when
 * their key moves. `facetsMode` is the sidebar's own retry.
 */
const requestAll = (
	model: Model,
	context: PageContext,
	window: TimeWindow,
	mode: RequestMode,
	facetsMode: RequestMode = "Load",
): Return => {
	const org = context.orgId
	const pin = context.pinnedNamespace
	const { search } = model
	const input = listInput(search, window, pin)
	const bucketSeconds = computeBucketSeconds(window.startTime, window.endTime, HISTOGRAM_TARGET_POINTS)
	const facetsInput = { window, attrs: search.attrs, pinnedNamespace: pin }
	const listArgs = { search, window, pinnedNamespace: pin }
	const steps: ReadonlyArray<(step: Step) => Step> = [
		(step) =>
			keyed(
				step,
				(m) => m.firstPage,
				requestKey(org, "listLogs", { data: input }),
				mode,
				(m, firstPage) => ({ ...m, firstPage }),
				(key) => FetchFirstPage({ key, ...listArgs }),
			),
		(step) =>
			!step.model.isFilterRailMounted
				? step
				: keyed(
						step,
						(m) => m.facets,
						requestKey(org, "getLogsFacets", facetsInput),
						facetsMode,
						(m, facets) => ({ ...m, facets }),
						(key) => FetchFacets({ key, ...facetsInput }),
					),
		(step) =>
			keyed(
				step,
				(m) => m.volume,
				requestKey(org, "getCustomChartTimeSeries", volumeInput(search, window, bucketSeconds, pin)),
				"Load",
				(m, volume) => ({ ...m, volume }),
				(key) => FetchVolume({ key, ...listArgs, bucketSeconds }),
			),
		(step) =>
			keyed(
				step,
				(m) => m.attributeKeys,
				requestKey(org, "getLogAttributeKeys", window),
				"Load",
				(m, attributeKeys) => ({ ...m, attributeKeys }),
				(key) => FetchAttributeKeys({ key, window }),
			),
	]
	const done = steps.reduce<Step>((step, next) => next(step), {
		model: { ...model, window },
		commands: [],
	})
	// A new first-page request owns a fresh set of later pages (`initialPagination`).
	const isNewFirstPage = done.model.firstPage.key !== model.firstPage.key
	return {
		model: isNewFirstPage
			? { ...done.model, pagination: freshPagination(model.pagination.generation + 1) }
			: done.model,
		commands: done.commands,
	}
}

/**
 * `useVirtualReachEnd` + `fetchNextPage`: once the window's last row is within `FETCH_THRESHOLD`
 * of the end, the next page is fetched, one at a time, never while the first page refreshes.
 */
const fetchIfNearEnd =
	(context: PageContext) =>
	(result: Return): Return => {
		const { model } = result
		const firstPage = firstPageOf(model)
		const lastIndex = model.stream.window.at(-1)?.index ?? -1
		const count = allLogs(firstPage, model.pagination).length
		const cursor = lastCursor(firstPage, model.pagination)
		if (
			lastIndex < 0 ||
			model.window === null ||
			model.firstPage.key === null ||
			model.pagination.isFetching ||
			AsyncData.isRefreshing(model.firstPage.data) ||
			!hasNextPage(firstPage, model.pagination) ||
			cursor === null ||
			lastIndex < count - FETCH_THRESHOLD
		)
			return result
		return {
			...result,
			model: { ...model, pagination: { ...model.pagination, isFetching: true } },
			commands: [
				...(result.commands ?? []),
				FetchNextPage({
					key: model.firstPage.key,
					search: model.search,
					window: model.window,
					pinnedNamespace: context.pinnedNamespace,
					generation: model.pagination.generation,
					cursor,
				}),
			],
		}
	}

// NAVIGATION

const navigate = (model: Model, search: Search, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOf(AppRoute.Logs({ search })), isReplace }),
})

const searchHref = (search: Search) => hrefOf(AppRoute.Logs({ search }))

const listOrUndefined = (values: ReadonlyArray<string>) => (values.length === 0 ? undefined : values)

const EXCLUDED_OF = {
	severities: "excludedSeverities",
	deploymentEnvs: "excludedDeploymentEnvs",
	namespaces: "excludedNamespaces",
	services: "excludedServices",
} as const satisfies Record<Facet, string>

/** `toggleOption`: include and exclude are exclusive per value. */
const toggledFacet = (search: Search, facet: Facet, name: string): Search => {
	const selected = search[facet] ?? []
	const excluded = search[EXCLUDED_OF[facet]] ?? []
	return {
		...search,
		[EXCLUDED_OF[facet]]: excluded.includes(name)
			? listOrUndefined(excluded.filter((v) => v !== name))
			: search[EXCLUDED_OF[facet]],
		[facet]: listOrUndefined(
			selected.includes(name) ? selected.filter((v) => v !== name) : [...selected, name],
		),
	}
}

const excludedFacet = (search: Search, facet: Facet, name: string): Search => {
	const selected = search[facet] ?? []
	const excluded = search[EXCLUDED_OF[facet]] ?? []
	return {
		...search,
		[facet]: listOrUndefined(selected.filter((v) => v !== name)),
		[EXCLUDED_OF[facet]]: listOrUndefined(
			excluded.includes(name) ? excluded.filter((v) => v !== name) : [...excluded, name],
		),
	}
}

const windowOnly = (search: Search): Search => ({
	startTime: search.startTime,
	endTime: search.endTime,
	timePreset: search.timePreset,
})

// ENTRY POINTS

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		firstPage: Keyed.idle(),
		pagination: freshPagination(0),
		facets: Keyed.idle(),
		volume: Keyed.idle(),
		attributeKeys: Keyed.idle(),
		volumeChart: Chart.init(),
		volumeBrush: NO_BRUSH,
		stream: LogsStream.init("logs", []),
		wrap: false,
		density: "compact",
		searchText: route.search.search ?? "",
		searchGeneration: 0,
		locale: "en-US",
		isInspecting: false,
		isScrolledAway: false,
		presence: SignalPresenceData.Loading(),
		filterSections: FilterSections.init(),
		timePicker: TimeRangePicker.init("logs-time-range"),
		refreshMenu: Menu.init("logs-refresh-menu"),
		toolbarTooltip: Tooltip.init("logs-toolbar-tooltip", { openDelayMs: 250 }),
		columnsPopover: Popover.init("logs-columns-popover", { align: "end" }),
		searchHelp: initSearchHelp(),
		detail: LogDetail.init("logs-detail"),
		selectedIndex: null,
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		refreshVersion: 0,
		isReloading: false,
		isFilterRailMounted: false,
	}
	return {
		model,
		commands: [
			LoadSignalPresence({ orgId: context.orgId }),
			ReadPreferences(),
			resolveCommand(model, context, "Load"),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

/** The search changed (a filter, the window, a column): re-resolve and re-request. */
export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const next = setStreamRows({ ...model, search: route.search }, context)
	// A moved window re-resolves, unsnapped after a Reload; any other change reads under the kept one.
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

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.window === null ? { model } : requestAll(model, context, model.window, "Load")

// STREAM

const foldStreamOut = (model: Model, out: LogsStream.OutMessage, context: PageContext): Return =>
	LogsStream.OutMessage.match<Return>(out, {
		OpenedLog: ({ index }) => {
			const row = model.stream.rows[index]
			if (row === undefined) return { model }
			const opened = LogDetail.open(model.detail, row.log, context)
			return liftChild({ ...model, detail: opened.model, selectedIndex: index }, opened.commands, (m) =>
				Message.GotDetailMessage({ message: m }),
			)
		},
		ChangedInspecting: ({ isInspecting, isScrolledAway }) => ({
			model: { ...model, isInspecting, isScrolledAway },
		}),
		ChoseAttributeFilter: ({ source, key, value, negated }) =>
			navigate(model, {
				...model.search,
				attrs: addLogAttributeFilter(model.search.attrs, { source, key, value, negated }),
			}),
	})

const foldStream = (model: Model, message: LogsStream.Message, context: PageContext): Return => {
	const result = LogsStream.update(model.stream, message)
	const streamed = { ...model, stream: result.model }
	const out =
		result.outMessage === undefined
			? { model: streamed }
			: foldStreamOut(streamed, result.outMessage, context)
	const withOut: Return = {
		model: out.model,
		commands: [
			...Command.mapMessages(result.commands ?? [], streamSlot.toParentMessage),
			...(out.commands ?? []),
		],
		outMessage: out.outMessage,
	}
	return message._tag === "ChangedVirtualWindow" ? fetchIfNearEnd(context)(withOut) : withOut
}

// UPDATE

/** Reload, live tick or Jump to latest: a new `refreshVersion`, unsnapped, with the 600 ms spin. */
const reload = (model: Model, context: PageContext): Return => {
	const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
	return {
		model: reloaded,
		commands: [
			resolveCommand(reloaded, context, "Refresh"),
			CompleteReloadSpin({ version: reloaded.refreshVersion }),
		],
	}
}

const acceptFirstPage = (
	model: Model,
	key: string,
	result: Result.Result<LogsPage, LoadFailure>,
	context: PageContext,
): Return => {
	const firstPage = Keyed.accept(model.firstPage, key, result)
	if (firstPage === model.firstPage) return { model }
	// A refreshed first page owns a fresh set of later pages; its rows replace the stream's.
	const next = { ...model, firstPage, pagination: freshPagination(model.pagination.generation + 1) }
	return fetchIfNearEnd(context)(replaceStreamRows(next, context))
}

const acceptNextPage = (
	model: Model,
	key: string,
	generation: number,
	result: Result.Result<LogsPage, LoadFailure>,
	context: PageContext,
): Return => {
	if (key !== model.firstPage.key || generation !== model.pagination.generation) return { model }
	const pagination: Pagination = Result.isSuccess(result)
		? { ...model.pagination, isFetching: false, pages: [...model.pagination.pages, result.success] }
		: { ...model.pagination, isFetching: false, isStopped: true }
	return fetchIfNearEnd(context)({ model: setStreamRows({ ...model, pagination }, context) })
}

const liftChild = <ChildMessage>(
	model: Model,
	commands: ReadonlyArray<Command.Command<ChildMessage, never, Resources>> | undefined,
	toMessage: (message: ChildMessage) => Message,
): Return => ({ model, commands: Command.mapMessages(commands ?? [], toMessage) })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, nowMs }, context, window, mode),
		CompletedFetchFirstPage: ({ key, result }) => acceptFirstPage(model, key, result, context),
		CompletedFetchNextPage: ({ key, generation, result }) =>
			acceptNextPage(model, key, generation, result, context),
		CompletedFetchFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		CompletedFetchVolume: ({ key, result }) => ({
			model: { ...model, volume: Keyed.accept(model.volume, key, result) },
		}),
		CompletedFetchAttributeKeys: ({ key, result }) => ({
			model: { ...model, attributeKeys: Keyed.accept(model.attributeKeys, key, result) },
		}),
		CompletedReadPreferences: ({ wrap, density, locale }) => ({
			model: { ...model, wrap, density, locale },
		}),
		CompletedSavePreference: () => ({ model }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		// `useSignalPresence` mounts with the empty state, so its "unknown" copy paints first.
		MountedFilterRail: () => {
			if (model.isFilterRailMounted) return { model }
			const mounted = { ...model, isFilterRailMounted: true }
			return mounted.window === null
				? { model: mounted }
				: requestAll(mounted, context, mounted.window, "Load")
		},
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		ClickedReload: () => reload(model, context),
		TickedAutoRefresh: () => reload(model, context),
		ClickedJumpToLatest: () => {
			const jumped = LogsStream.jumpToLatest(model.stream)
			const next = reload({ ...model, stream: jumped.model, ...inspectOf(jumped.outMessage) }, context)
			return {
				...next,
				commands: [
					...Command.mapMessages(jumped.commands ?? [], streamSlot.toParentMessage),
					...(next.commands ?? []),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedRetryFacets: () =>
			model.window === null || model.facets.key === null
				? { model }
				: requestAll(model, context, model.window, "Load", "Refresh"),
		ToggledFacetOption: ({ facet, name }) => navigate(model, toggledFacet(model.search, facet, name)),
		ClickedOnlyFacetOption: ({ facet, name }) =>
			navigate(model, { ...model.search, [facet]: [name], [EXCLUDED_OF[facet]]: undefined }),
		ClickedExcludeFacetOption: ({ facet, name }) =>
			navigate(model, excludedFacet(model.search, facet, name)),
		ClickedClearAllFilters: () => navigate({ ...model, searchText: "" }, windowOnly(model.search)),
		RemovedFilterChip: ({ chipId: id }) =>
			navigate(
				model,
				withoutChips(
					model.search,
					logFilterChips(model.search).filter((chip) => chipId(chip) === id),
				),
			),
		ClickedClearExclusions: () =>
			navigate(
				model,
				withoutChips(
					model.search,
					logFilterChips(model.search).filter((chip) => chip.negated),
				),
			),
		ClickedClearFilterChips: () =>
			navigate(model, withoutChips(model.search, logFilterChips(model.search))),
		ChangedSearchText: ({ text }) => {
			const searchGeneration = model.searchGeneration + 1
			return {
				model: { ...model, searchText: text, searchGeneration },
				commands: [WaitSearchDebounce({ generation: searchGeneration })],
			}
		},
		ElapsedSearchDebounce: ({ generation }) => {
			if (generation !== model.searchGeneration) return { model }
			// A pasted trace id (or traceparent) becomes the trace scope; anything else searches bodies.
			const query = parseLogSearch(model.searchText)
			return query?.kind === "trace"
				? navigate(
						{ ...model, searchText: "" },
						{ ...model.search, search: undefined, traceId: query.traceId },
					)
				: navigate(model, { ...model.search, search: query?.text })
		},
		ClickedWrap: () => savePreferences({ ...model, wrap: !model.wrap }),
		ClickedDensity: () =>
			savePreferences({ ...model, density: model.density === "compact" ? "comfortable" : "compact" }),
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
		ClickedClearSearch: () =>
			navigate(
				{ ...model, searchText: "" },
				{ ...model.search, search: undefined, traceId: undefined },
			),
		ClickedWidenRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: WIDEN_TIME_PRESET,
			}),
		GotStreamMessage: ({ message: inner }) => foldStream(model, inner, context),
		GotFilterSectionsMessage: ({ message: inner }) => {
			const next = FilterSections.update(model.filterSections, inner)
			return liftChild({ ...model, filterSections: next.model }, next.commands, (m) =>
				Message.GotFilterSectionsMessage({ message: m }),
			)
		},
		GotToolbarTooltipMessage: ({ message: inner }) => {
			const next = Tooltip.update(model.toolbarTooltip, inner)
			return liftChild({ ...model, toolbarTooltip: next.model }, next.commands, (m) =>
				Message.GotToolbarTooltipMessage({ message: m }),
			)
		},
		GotColumnsPopoverMessage: ({ message: inner }) => {
			const next = Popover.update(model.columnsPopover, inner)
			return liftChild({ ...model, columnsPopover: next.model }, next.commands, (m) =>
				Message.GotColumnsPopoverMessage({ message: m }),
			)
		},
		GotDetailMessage: ({ message: inner }) => {
			const next = LogDetail.update(model.detail, inner)
			const lifted = liftChild({ ...model, detail: next.model }, next.commands, (m) =>
				Message.GotDetailMessage({ message: m }),
			)
			const out = next.outMessage
			if (out === undefined) return lifted
			if (out._tag === "Closed") return { ...lifted, model: { ...lifted.model, selectedIndex: null } }
			if (out._tag === "Copied") return { ...lifted, outMessage: copyToast(out.label, out.isOk) }
			return {
				...navigate(lifted.model, {
					...model.search,
					attrs: addLogAttributeFilter(model.search.attrs, {
						source: out.source,
						key: out.key,
						value: out.value,
						negated: out.negated,
					}),
				}),
				commands: lifted.commands,
			}
		},
		GotSearchHelpMessage: ({ message: inner }) => {
			const next = Popover.update(model.searchHelp, inner)
			return liftChild({ ...model, searchHelp: next.model }, next.commands, (m) =>
				Message.GotSearchHelpMessage({ message: m }),
			)
		},
		// `setColumns`: the picked keys in `?columns`, none leaves the URL.
		ToggledColumn: ({ key }) => {
			const pinned = model.search.columns ?? []
			const next = pinned.includes(key) ? pinned.filter((k) => k !== key) : [...pinned, key]
			return navigate(model, { ...model.search, columns: next.length > 0 ? next : undefined })
		},
		GotRefreshMenuMessage: ({ message: inner }) => {
			const next = Menu.update(model.refreshMenu, inner)
			const lifted = liftChild({ ...model, refreshMenu: next.model }, next.commands, (m) =>
				Message.GotRefreshMenuMessage({ message: m }),
			)
			if (next.outMessage?._tag !== "SelectedRadio") return lifted
			// The cadence lives in `?refresh=`, written in place (a replace, not a new entry).
			const seconds = Number(next.outMessage.value)
			return {
				...navigate(
					lifted.model,
					{ ...model.search, refresh: seconds === 0 ? undefined : seconds },
					true,
				),
				commands: lifted.commands,
			}
		},
		GotVolumeChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.volumeChart, inner)
			// `handleBucketHover`: while dragging, every bucket crossed extends the selection.
			const hovered = inner._tag === "ChangedChartFocus" ? Option.getOrNull(inner.maybeKey) : null
			const volumeBrush =
				model.volumeBrush.isSelecting && hovered !== null
					? { ...model.volumeBrush, right: hovered }
					: model.volumeBrush
			return liftChild({ ...model, volumeChart: next.model, volumeBrush }, next.commands, (m) =>
				Message.GotVolumeChartMessage({ message: m }),
			)
		},
		PressedVolumeChart: () =>
			Option.match(model.volumeChart.activeKey, {
				onNone: () => ({ model }),
				onSome: (bucket) => ({
					model: { ...model, volumeBrush: { left: bucket, right: null, isSelecting: true } },
				}),
			}),
		ReleasedVolumeChart: () => {
			const { left, right, isSelecting } = model.volumeBrush
			const cleared = { ...model, volumeBrush: NO_BRUSH }
			const buckets = Option.getOrUndefined(AsyncData.getData(model.volume.data)) ?? []
			const range = isSelecting && left !== null ? brushRange(left, right ?? left, buckets) : undefined
			// `onTimeRangeSelect`: `applyTimeRangeSearch` with absolute bounds, as a replace.
			return range === undefined
				? { model: cleared }
				: navigate(cleared, { ...model.search, ...range, timePreset: undefined }, true)
		},
		LeftVolumeChart: () =>
			model.volumeBrush.isSelecting ? { model: { ...model, volumeBrush: NO_BRUSH } } : { model },
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted = liftChild({ ...model, timePicker: next.model }, next.commands, (m) =>
				Message.GotTimePickerMessage({ message: m }),
			)
			// `applyTimeRangeSearch` with a preset: the absolute bounds leave the URL.
			return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
				? lifted
				: {
						...lifted,
						...navigate(lifted.model, {
							...model.search,
							...TimeRangePicker.searchPatchOf(next.outMessage),
						}),
						commands: lifted.commands,
					}
		},
	})

const savePreferences = (model: Model): Return => ({
	model,
	commands: [SavePreferences({ wrap: model.wrap, density: model.density })],
})
