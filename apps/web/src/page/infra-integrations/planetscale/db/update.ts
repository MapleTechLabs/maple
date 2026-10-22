import { AsyncData, Command } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import * as Keyed from "../../../../data/keyed"
import { requestSlot } from "../../kit/slot"
import { requestKey } from "../../../../data/request-key"
import type { Resources } from "../../../../platform/resources"
import { AppRoute, hrefOf } from "../../../../route"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Select from "../../../../ui/select"
import * as Tooltip from "../../../../ui/tooltip"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { nextSort } from "../../../kit/table-sort"
import { toggleFilterValue } from "../filters"
import {
	CompleteReloadSpin,
	FetchBranchStats,
	FetchDatabases,
	FetchEvents,
	FetchInsights,
	FetchTimeseries,
	LoadStatus,
	ResolveWindow,
} from "./command"
import { eventsInputOf, filtersOf, insightsInputOf, timeseriesInputOf } from "./derive"
import { Message, type Model, type RequestMode } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = { readonly dbName: string; readonly search: Search }

export const DEFAULT_PRESET = "12h"
export const CHART_METRICS = [
	"storageUsedPercent",
	"connectionsAvg",
	"cpuMaxPercent",
	"memMaxPercent",
	"replicaLagMaxSeconds",
] as const

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const hrefOfSearch = (model: Model, search: Search) =>
	hrefOf(AppRoute.InfraPlanetscaleDatabase({ dbName: model.dbName, search }))

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOfSearch(model, search), isReplace: false }),
})

/** One slot request: the next slot and its fetch, or nothing when the key is already in hand. */
const slot = requestSlot

/** The scoped reads (`PlanetScaleDatabaseData`): they re-key whenever the resolved branch moves. */
const requestScoped = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const { window, localWindow } = model
	if (window === null || localWindow === null) return { model }
	const org = context.orgId
	const tsInput = timeseriesInputOf(model, window)
	const eventsInput = eventsInputOf(model, localWindow)
	const insightsInput = insightsInputOf(model, window)
	const [timeseries, a] = slot(
		model.timeseries,
		requestKey(org, "getPlanetScaleInfraTimeseries", { data: tsInput }),
		mode,
		() =>
			FetchTimeseries({
				key: requestKey(org, "getPlanetScaleInfraTimeseries", { data: tsInput }),
				input: tsInput,
			}),
	)
	const [events, b] = slot(
		model.events,
		requestKey(org, "getPlanetScaleEvents", { data: eventsInput }),
		mode,
		() =>
			FetchEvents({
				key: requestKey(org, "getPlanetScaleEvents", { data: eventsInput }),
				input: eventsInput,
			}),
	)
	const [insights, c] = slot(
		model.insights,
		requestKey(org, "getPlanetScaleQueryInsights", { data: insightsInput }),
		mode,
		() =>
			FetchInsights({
				key: requestKey(org, "getPlanetScaleQueryInsights", { data: insightsInput }),
				input: insightsInput,
			}),
	)
	return { model: { ...model, timeseries, events, insights }, commands: [...a, ...b, ...c] }
}

const requestWindowed = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = model.window
	if (window === null) return { model }
	const key = requestKey(context.orgId, "getPlanetScaleBranchStats", {
		data: { database: model.dbName, ...window },
	})
	const [branchStats, commands] = slot(model.branchStats, key, mode, () =>
		FetchBranchStats({ key, window, database: model.dbName }),
	)
	const scoped = requestScoped({ ...model, branchStats }, context, mode)
	return { model: scoped.model, commands: [...commands, ...(scoped.commands ?? [])] }
}

/** A read settled: the branch may resolve differently now, which re-keys the scoped reads. */
const settled = (model: Model, context: PageContext): Return => requestScoped(model, context, "Load")

export const init = (route: Route, context: PageContext): Return => {
	const statusKey = requestKey(context.orgId, "planetscaleIntegration.status", {})
	const databasesKey = requestKey(context.orgId, "planetscaleIntegration.databases", {})
	const model: Model = {
		dbName: route.dbName,
		search: route.search,
		window: null,
		nowMs: 0,
		localWindow: null,
		status: { key: statusKey, data: AsyncData.Loading() },
		databases: { key: databasesKey, data: AsyncData.Loading() },
		branchStats: Keyed.idle(),
		timeseries: Keyed.idle(),
		events: Keyed.idle(),
		insights: Keyed.idle(),
		measure: "connections",
		breakdownSort: { key: "value", dir: "desc" },
		charts: Object.fromEntries(CHART_METRICS.map((metric) => [metric, Chart.init()])),
		branchSelect: Select.init("planetscale-branch-select", { value: "", selectedIndex: null }),
		filterSections: FilterSections.init(),
		tooltip: Tooltip.init("planetscale-db-tooltip"),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		timePicker: TimeRangePicker.init("planetscale-db-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			LoadStatus({ key: statusKey }),
			FetchDatabases({ key: databasesKey }),
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

export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	if (hrefOfSearch(model, model.search) === hrefOfSearch(model, route.search)) return { model }
	const next = { ...model, search: route.search }
	const resolve = (): Return => {
		const scoped = requestScoped(next, context, "Load")
		return {
			model: scoped.model,
			commands: [
				resolveCommand(next, context, snapModeOf(model.refreshVersion)),
				...(scoped.commands ?? []),
			],
		}
	}
	return routeWindowStep(model.search, route.search, {
		resolve,
		requestAll: (mode) => (next.window === null ? resolve() : requestWindowed(next, context, mode)),
	})
}

export const contextChanged = (model: Model): Return => ({ model })

/** `setFilter`: an emptied filter leaves the URL; the legacy `?branch=` is never written back. */
const setFilter = (
	model: Model,
	key: "branches" | "branchStates" | "branchRoles" | "branchContains",
	values: ReadonlyArray<string> | string | undefined,
) => navigate(model, { ...model.search, branch: undefined, [key]: values })

const lift = <S, I>(
	model: Model,
	next: { readonly model: S; readonly commands?: ReadonlyArray<Command.Command<I, never, Resources>> },
	patch: (state: S) => Partial<Model>,
	wrap: (message: I) => Message,
): Return => ({
	model: { ...model, ...patch(next.model) },
	commands: Command.mapMessages(next.commands ?? [], wrap),
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, localWindow, nowMs, mode }) =>
			requestWindowed({ ...model, window, localWindow, nowMs }, context, mode),
		CompletedLoadStatus: ({ key, result }) =>
			settled({ ...model, status: Keyed.accept(model.status, key, result) }, context),
		CompletedFetchDatabases: ({ key, result }) =>
			settled({ ...model, databases: Keyed.accept(model.databases, key, result) }, context),
		CompletedFetchBranchStats: ({ key, result }) =>
			settled({ ...model, branchStats: Keyed.accept(model.branchStats, key, result) }, context),
		CompletedFetchTimeseries: ({ key, result }) => ({
			model: { ...model, timeseries: Keyed.accept(model.timeseries, key, result) },
		}),
		CompletedFetchEvents: ({ key, result }) => ({
			model: { ...model, events: Keyed.accept(model.events, key, result) },
		}),
		CompletedFetchInsights: ({ key, result }) => ({
			model: { ...model, insights: Keyed.accept(model.insights, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		ClickedRetryTimeseries: () => {
			if (model.window === null) return { model }
			const input = timeseriesInputOf(model, model.window)
			const key = requestKey(context.orgId, "getPlanetScaleInfraTimeseries", { data: input })
			const [timeseries, commands] = slot(model.timeseries, key, "Refresh", () =>
				FetchTimeseries({ key, input }),
			)
			return { model: { ...model, timeseries }, commands }
		},
		ClickedRetryBranchStats: () => requestWindowed(model, context, "Refresh"),
		ClickedMeasure: ({ measure }) => ({ model: { ...model, measure } }),
		ClickedBreakdownSort: ({ key }) => ({
			model: {
				...model,
				breakdownSort: nextSort(model.breakdownSort, key, { stringKeys: ["branch"] }),
			},
		}),
		ToggledBranch: ({ branch }) =>
			setFilter(model, "branches", toggleFilterValue(filtersOf(model).branches, branch)),
		SelectedBranch: ({ branch }) =>
			navigate(model, {
				...model.search,
				branch: undefined,
				branches: branch === undefined ? undefined : [branch],
			}),
		ToggledFilterOption: ({ key, name }) =>
			key === "branchContains"
				? setFilter(model, key, undefined)
				: setFilter(model, key, toggleFilterValue(filtersOf(model)[key], name)),
		RemovedFilterChip: ({ key, value }) =>
			key === "branchContains"
				? setFilter(model, key, undefined)
				: setFilter(model, key, toggleFilterValue(filtersOf(model)[key], value)),
		ClickedClearFilters: () =>
			navigate(model, {
				...model.search,
				branch: undefined,
				branches: undefined,
				branchStates: undefined,
				branchRoles: undefined,
				branchContains: undefined,
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
		ClickedResetTimeRange: () => navigate(model, withPreset(model.search, DEFAULT_PRESET)),
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		GotTimePickerMessage: ({ message: inner }) => {
			const step = stepTimePicker(
				model.timePicker,
				inner,
				(picker) => Message.GotTimePickerMessage({ message: picker }),
				(preset) => hrefOfSearch(model, withPreset(model.search, preset)),
			)
			return {
				model: { ...model, timePicker: step.timePicker },
				commands: step.commands,
				outMessage: step.outMessage,
			}
		},
		GotChartMessage: ({ chartId, message: inner }) =>
			lift(
				model,
				Chart.update(model.charts[chartId] ?? Chart.init(), inner),
				(chart) => ({ charts: { ...model.charts, [chartId]: chart } }),
				(chart) => Message.GotChartMessage({ chartId, message: chart }),
			),
		GotBranchSelectMessage: ({ message: inner }) => {
			const next = Select.update(model.branchSelect, inner)
			const lifted = lift(
				model,
				next,
				(branchSelect) => ({ branchSelect }),
				(select) => Message.GotBranchSelectMessage({ message: select }),
			)
			return next.outMessage === undefined
				? lifted
				: {
						...lifted,
						outMessage: navigate(model, {
							...model.search,
							branch: undefined,
							branches: [next.outMessage.value],
						}).outMessage,
					}
		},
		GotFilterSectionsMessage: ({ message: inner }) =>
			lift(
				model,
				FilterSections.update(model.filterSections, inner),
				(filterSections) => ({ filterSections }),
				(sections) => Message.GotFilterSectionsMessage({ message: sections }),
			),
		GotTooltipMessage: ({ message: inner }) =>
			lift(
				model,
				Tooltip.update(model.tooltip, inner),
				(tooltip) => ({ tooltip }),
				(tip) => Message.GotTooltipMessage({ message: tip }),
			),
	})
