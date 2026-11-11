import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { chartEnvHandlers } from "@maple/views/charts/chart-env"
import { LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import type { Resources } from "../../platform/resources"
import { AppRoute, hrefOf } from "../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { applySteps, chain, keyed } from "../kit/keyed-step"
import { pickerStep } from "../kit/page-time"
import { routeWindowStep, snapModeOf } from "../kit/route-window"
import type { PresetValue } from "../kit/time-controls"
import * as TimeRangePicker from "../kit/time-range-picker"
import {
	type BreakdownInput,
	CompleteReloadSpin,
	FetchCostBreakdown,
	FetchCostSources,
	FetchCostTimeseries,
	FetchCostTotals,
	ResolveWindow,
	type TimeseriesInput,
	type WindowInput,
} from "./command"
import {
	DEFAULT_GROUP_BY,
	groupByOf,
	hasSynced,
	requestFilters,
	sortOf,
	withoutFilter,
	withoutFilters,
} from "./derive"
import { Message } from "./message"
import type { Model, Search } from "./model"

type Return = PageReturn<Model, Message>
type Cmd = Command.Command<Message, never, Resources>

export const DEFAULT_PRESET: PresetValue = "30d"

/** The keys that get their own series in the chart; the rest fold into "Other". */
export const SERIES_LIMIT = 8
const BREAKDOWN_LIMIT = 100

const resolveCommand = (model: Model, context: PageContext, mode: Keyed.RequestMode): Cmd =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Cost({ search })),
		isReplace: false,
	}),
})

const requestSources = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return =>
	applySteps<Model, Message>(model, [
		keyed(
			model.sources,
			requestKey(context.orgId, "costSources", {}),
			mode,
			(sources) => ({ sources }),
			(key) => FetchCostSources({ key }),
		),
	])

/** The window's reads, once a source has cost to read: an org with none sends no warehouse query. */
const requestData = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const sources = Option.getOrUndefined(AsyncData.getData(model.sources.data))
	if (model.window === null || sources === undefined || !hasSynced(sources.sources)) return { model }
	const filters = requestFilters(model.search)
	const window: WindowInput = {
		startTime: model.window.startTime,
		endTime: model.window.endTime,
		...(filters === undefined ? undefined : { filters }),
	}
	const groupBy = groupByOf(model.search)
	const timeseries: TimeseriesInput = { ...window, groupBy, limit: SERIES_LIMIT }
	// The order is the read's own: sorted by change, the top rows are the largest moves.
	const breakdown: BreakdownInput = {
		...window,
		groupBy,
		sortBy: sortOf(model.search),
		limit: BREAKDOWN_LIMIT,
	}
	return applySteps<Model, Message>(model, [
		keyed(
			model.totals,
			requestKey(context.orgId, "costTotals", { data: window }),
			mode,
			(totals) => ({ totals }),
			(key) => FetchCostTotals({ key, input: window }),
		),
		keyed(
			model.timeseries,
			requestKey(context.orgId, "costTimeseries", { data: timeseries }),
			mode,
			(next) => ({ timeseries: next }),
			(key) => FetchCostTimeseries({ key, input: timeseries }),
		),
		keyed(
			model.breakdown,
			requestKey(context.orgId, "costBreakdown", { data: breakdown }),
			mode,
			(next) => ({ breakdown: next }),
			(key) => FetchCostBreakdown({ key, input: breakdown }),
		),
	])
}

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		sources: Keyed.idle(),
		totals: Keyed.idle(),
		timeseries: Keyed.idle(),
		breakdown: Keyed.idle(),
		timePicker: TimeRangePicker.init("cost-time-range"),
		chart: Chart.init(),
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		refreshVersion: 0,
		isReloading: false,
	}
	return chain<Model, Message>(
		{ model, commands: [resolveCommand(model, context, "Load"), LoadChartRuntime()] },
		(next) => requestSources(next, context, "Load"),
	)
}

const searchHref = (search: Search) => hrefOf(AppRoute.Cost({ search }))

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const next = { ...model, search: route.search }
	return routeWindowStep(model.search, route.search, {
		resolve: (): Return => ({
			model: next,
			commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
		}),
		requestAll: (mode) => requestData(next, context, mode),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	requestData(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestData({ ...model, window, nowMs }, context, mode),
		// The sources' answer decides whether there is anything to read; a failed one reads nothing.
		CompletedLoadSources: ({ key, result }) =>
			requestData({ ...model, sources: Keyed.accept(model.sources, key, result) }, context, "Load"),
		CompletedLoadTotals: ({ key, result }) => ({
			model: { ...model, totals: Keyed.accept(model.totals, key, result) },
		}),
		CompletedLoadTimeseries: ({ key, result }) => ({
			model: { ...model, timeseries: Keyed.accept(model.timeseries, key, result) },
		}),
		CompletedLoadBreakdown: ({ key, result }) => ({
			model: { ...model, breakdown: Keyed.accept(model.breakdown, key, result) },
		}),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return chain<Model, Message>(
				{
					model: reloaded,
					commands: [
						resolveCommand(reloaded, context, "Refresh"),
						CompleteReloadSpin({ version: reloaded.refreshVersion }),
					],
				},
				(next) => requestSources(next, context, "Refresh"),
			)
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedResetTimeRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: undefined,
			}),
		// `Load` asks again only for a read that failed; one that answered keeps its data.
		ClickedRetry: () =>
			chain<Model, Message>(requestSources(model, context, "Load"), (next) =>
				requestData(next, context, "Load"),
			),
		// The defaults stay out of the URL.
		PickedGroupBy: ({ groupBy }) =>
			navigate(model, {
				...model.search,
				groupBy: groupBy === DEFAULT_GROUP_BY ? undefined : groupBy,
			}),
		ClickedSort: ({ sort }) =>
			navigate(model, { ...model.search, sort: sort === "cost" ? undefined : sort }),
		ClickedRemoveFilter: (filter) => navigate(model, withoutFilter(model.search, filter)),
		ClickedClearFilters: () => navigate(model, withoutFilters(model.search)),
		GotTimePickerMessage: ({ message: inner }) =>
			pickerStep(
				model,
				inner,
				(picker) => Message.GotTimePickerMessage({ message: picker }),
				(patch) => navigate(model, { ...model.search, ...patch }).outMessage,
			),
		GotChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.chart, inner)
			return {
				model: { ...model, chart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ message: chart }),
				),
			}
		},
		...chartEnvHandlers(model),
	})
