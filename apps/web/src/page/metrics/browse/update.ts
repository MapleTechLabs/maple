import { toQueryBuilderMetricType } from "@maple/query-model"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import type { MetricsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { SignalPresenceData } from "../../kit/signal-presence"
import { routeWindowStep, snapModeOf } from "../../kit/route-window"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { SPARKLINE_METRIC_TYPES } from "../shared"
import {
	CompleteReloadSpin,
	DebounceSearch,
	FetchCatalog,
	FetchSparklines,
	FetchSummary,
	FetchTable,
	type ListInput,
	LoadSignalPresence,
	ResolveWindow,
} from "./command"
import {
	CATALOG_LIMIT,
	gridPages,
	namesOfType,
	sparklineRequest,
	TABLE_MAX_LIMIT,
	TABLE_PAGE_SIZE,
	toEntries,
} from "./derive"
import { Message, type RequestMode } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = typeof MetricsSearch.Type
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

/** `DashboardPage`'s `defaultPreset` for `/metrics`. */
export const DEFAULT_PRESET = "24h"
export const TYPE_SELECT_ID = "metrics-type-filter"

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const listInput = (search: Search, window: TimeWindow, limit: number): ListInput => ({
	search: search.q === undefined || search.q === "" ? undefined : search.q,
	metricType: search.type,
	limit,
	startTime: window.startTime,
	endTime: window.endTime,
})

/** One `Keyed.request`, its Model patch and fetch (S6). */
const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): Readonly<{ slot: Keyed.Keyed<A, E>; commands: Commands }> =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => ({ slot, commands: [] }),
		onSome: (next) => ({ slot: next, commands: [fetch(key)] }),
	})

/** The mounted grid pages' sparkline queries, one per metric type present on the page. */
const requestSparklines = (model: Model, context: PageContext, mode: RequestMode): Return => {
	const catalog = AsyncData.getData(model.catalog.data)
	if (model.window === null || Option.isNone(catalog) || (model.search.view ?? "grid") !== "grid") {
		return { model }
	}
	const { window } = model
	const pages = gridPages(toEntries(catalog.value), model.visiblePages)
	const steps = pages.flatMap((entries) =>
		SPARKLINE_METRIC_TYPES.flatMap((metricType) => {
			const metricNames = namesOfType(entries, metricType)
			if (metricNames.length === 0) return []
			const { key: slotKey, input } = sparklineRequest(context.orgId, window, metricType, metricNames)
			const step = keyed(model.sparklines[slotKey] ?? Keyed.idle(), slotKey, mode, (key) =>
				FetchSparklines({ slot: slotKey, key, input }),
			)
			return [{ slotKey, ...step }]
		}),
	)
	return {
		model: {
			...model,
			sparklines: {
				...model.sparklines,
				...Object.fromEntries(steps.map((step) => [step.slotKey, step.slot])),
			},
		},
		commands: steps.flatMap((step) => step.commands),
	}
}

/** Every query the page reads for the resolved window. */
const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const org = context.orgId
	const summary = keyed(
		model.summary,
		requestKey(org, "getMetricsSummary", { data: window }),
		mode,
		(key) => FetchSummary({ key, window }),
	)
	const isGrid = (model.search.view ?? "grid") === "grid"
	const catalogInput = listInput(model.search, window, CATALOG_LIMIT)
	const tableInput = listInput(model.search, window, Math.min(model.tableLimit + 1, TABLE_MAX_LIMIT))
	const catalog = isGrid
		? keyed(model.catalog, requestKey(org, "listMetrics", { data: catalogInput }), mode, (key) =>
				FetchCatalog({ key, input: catalogInput }),
			)
		: { slot: model.catalog, commands: [] }
	const table = isGrid
		? { slot: model.table, commands: [] }
		: keyed(model.table, requestKey(org, "listMetrics", { data: tableInput }), mode, (key) =>
				FetchTable({ key, input: tableInput }),
			)
	const next = requestSparklines(
		{ ...model, window, summary: summary.slot, catalog: catalog.slot, table: table.slot },
		context,
		mode,
	)
	return {
		model: next.model,
		commands: [...summary.commands, ...catalog.commands, ...table.commands, ...(next.commands ?? [])],
	}
}

/** `MetricsBrowse`'s `key`: a new search, type or window remounts the grid or table. */
const remounted = (model: Model, isNewQuery: boolean): Model => {
	const reset = { ...model, visiblePages: 1, tableLimit: TABLE_PAGE_SIZE }
	// A new window keeps the previous rows on screen while it loads (`withRetention`).
	return isNewQuery ? { ...reset, catalog: Keyed.idle(), table: Keyed.idle() } : reset
}

// NAVIGATION

/** `handlePatch`: filter and view changes replace the history entry. */
const patchSearch = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Metrics({ search })),
		isReplace: true,
	}),
})

const searchHref = (search: Search) => hrefOf(AppRoute.Metrics({ search }))

const isSameQuery = (a: Search, b: Search) => (a.q ?? "") === (b.q ?? "") && a.type === b.type

const typeSelectValue = (search: Search) => search.type ?? "all"

// ENTRY POINTS

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		catalog: Keyed.idle(),
		visiblePages: 1,
		sparklines: {},
		table: Keyed.idle(),
		tableLimit: TABLE_PAGE_SIZE,
		summary: Keyed.idle(),
		searchInput: route.search.q ?? "",
		searchGeneration: 0,
		lastSentQuery: route.search.q ?? "",
		typeSelect: Select.init(TYPE_SELECT_ID, {
			value: typeSelectValue(route.search),
			selectedIndex: null,
		}),
		presence: SignalPresenceData.Loading(),
		timePicker: TimeRangePicker.init("metrics-time-range"),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			LoadSignalPresence({ orgId: context.orgId }),
			resolveCommand(model, context, "Load"),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

/** A filter, the view or the window changed: re-request, re-resolving only a moved window. */
export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const query = route.search.q ?? ""
	// `ToolbarSearch` resyncs its input on an outside change, never on its own echo.
	const isOutsideQuery = query !== model.lastSentQuery
	const base: Model = {
		...remounted({ ...model, search: route.search }, !isSameQuery(model.search, route.search)),
		typeSelect: { ...model.typeSelect, value: typeSelectValue(route.search) },
	}
	const next: Model = isOutsideQuery ? { ...base, searchInput: query, lastSentQuery: query } : base
	const resolve = (): Return => ({
		model: next,
		commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
	})
	// A filter or view change reads its new keys under the kept window; only a moved window re-resolves.
	return routeWindowStep(model.search, route.search, {
		resolve,
		requestAll: (mode) =>
			next.window === null ? resolve() : requestAll(next, context, next.window, mode),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.window === null ? { model } : requestAll(model, context, model.window, "Load")

const metricHref = (model: Model, metricName: string, metricType: string) =>
	hrefOf(
		AppRoute.Metric({
			metricName,
			search: {
				startTime: model.search.startTime,
				endTime: model.search.endTime,
				timePreset: model.search.timePreset,
				type: toQueryBuilderMetricType(metricType) ?? undefined,
			},
		}),
	)

/** `MetricsTable`'s row link: the page's own time params plus the metric's type. */
export const metricLink = metricHref

const liftTypeSelect = (model: Model, message: Select.Message): Return => {
	const next = Select.update(model.typeSelect, message)
	const lifted: Return = {
		model: { ...model, typeSelect: next.model },
		commands: Command.mapMessages(next.commands, (inner) =>
			Message.GotTypeSelectMessage({ message: inner }),
		),
	}
	if (next.outMessage === undefined) return lifted
	const picked = toQueryBuilderMetricType(next.outMessage.value) ?? undefined
	return { ...lifted, outMessage: patchSearch(lifted.model, { ...model.search, type: picked }).outMessage }
}

const liftTimePicker = (model: Model, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const lifted: Return = {
		model: { ...model, timePicker: next.model },
		commands: Command.mapMessages(next.commands, (inner) =>
			Message.GotTimePickerMessage({ message: inner }),
		),
	}
	// `applyTimeRangeSearch` with a preset: the absolute bounds leave the URL (a push, not a replace).
	return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
		? lifted
		: {
				...lifted,
				outMessage: PageOutMessage.RequestedNavigation({
					url: searchHref({
						...model.search,
						...TimeRangePicker.searchPatchOf(next.outMessage),
					}),
					isReplace: false,
				}),
			}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, nowMs }, context, window, mode),
		CompletedFetchCatalog: ({ key, result }) =>
			requestSparklines(
				{ ...model, catalog: Keyed.accept(model.catalog, key, result) },
				context,
				"Load",
			),
		CompletedFetchTable: ({ key, result }) => ({
			model: { ...model, table: Keyed.accept(model.table, key, result) },
		}),
		CompletedFetchSummary: ({ key, result }) => ({
			model: { ...model, summary: Keyed.accept(model.summary, key, result) },
		}),
		CompletedFetchSparklines: ({ slot, key, result }) => {
			const current = model.sparklines[slot]
			return current === undefined
				? { model }
				: {
						model: {
							...model,
							sparklines: { ...model.sparklines, [slot]: Keyed.accept(current, key, result) },
						},
					}
		},
		ChangedSearchInput: ({ value }) => {
			const searchGeneration = model.searchGeneration + 1
			return {
				model: { ...model, searchInput: value, searchGeneration },
				commands: [DebounceSearch({ generation: searchGeneration })],
			}
		},
		CompletedSearchDebounce: ({ generation }) => {
			if (generation !== model.searchGeneration) return { model }
			const trimmed = model.searchInput.trim()
			return patchSearch(
				{ ...model, lastSentQuery: trimmed },
				{ ...model.search, q: trimmed === "" ? undefined : trimmed },
			)
		},
		ClickedClearSearch: () => {
			const searchGeneration = model.searchGeneration + 1
			return {
				model: { ...model, searchInput: "", searchGeneration },
				commands: [DebounceSearch({ generation: searchGeneration })],
			}
		},
		ClickedView: ({ view }) =>
			(model.search.view ?? "grid") === view
				? { model }
				: patchSearch(model, { ...model.search, view: view === "grid" ? undefined : view }),
		ClickedLoadMorePages: () =>
			requestSparklines({ ...model, visiblePages: model.visiblePages + 1 }, context, "Load"),
		ClickedLoadMoreTable: () => {
			const next = { ...model, tableLimit: model.tableLimit + TABLE_PAGE_SIZE }
			return next.window === null ? { model: next } : requestAll(next, context, next.window, "Load")
		},
		ClickedMetricCard: ({ metricName, metricType }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: metricHref(model, metricName, metricType),
				isReplace: false,
			}),
		}),
		ClickedClearFilters: () => patchSearch(model, { ...model.search, q: undefined, type: undefined }),
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
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
			patchSearch(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		GotTypeSelectMessage: ({ message: inner }) => liftTypeSelect(model, inner),
		GotTimePickerMessage: ({ message: inner }) => liftTimePicker(model, inner),
		GotSparklineMessage: () => ({ model }),
	})
