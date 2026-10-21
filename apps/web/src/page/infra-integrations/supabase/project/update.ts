import { Command } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import { CHART_IDS } from "./charts"
import {
	CompleteReloadSpin,
	FetchProjects,
	FetchTimeseries,
	LoadStatus,
	ResolveWindow,
	type TimeseriesInput,
} from "./command"
import { Message, type RequestMode } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = { readonly projectRef: string; readonly search: Search }

export const DEFAULT_PRESET = "6h"

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

export const timeseriesInput = (model: Model, window: TimeWindow): TimeseriesInput => ({
	startTime: window.startTime,
	endTime: window.endTime,
	bucketSeconds: Math.max(60, chartBucketSeconds(window.startTime, window.endTime)),
	projectRef: model.projectRef,
})

const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const projectsKey = requestKey(context.orgId, "getSupabaseProjects", { data: window })
	const input = timeseriesInput(model, window)
	const seriesKey = requestKey(context.orgId, "getSupabaseProjectTimeseries", { data: input })
	const [projects, projectFetches] = requestSlot(model.projects, projectsKey, mode, () =>
		FetchProjects({ key: projectsKey, window }),
	)
	const [timeseries, seriesFetches] = requestSlot(model.timeseries, seriesKey, mode, () =>
		FetchTimeseries({ key: seriesKey, input }),
	)
	return {
		model: { ...model, window, projects, timeseries },
		commands: [...projectFetches, ...seriesFetches],
	}
}

const searchHref = (model: Model, search: Search) =>
	hrefOf(AppRoute.InfraSupabaseProject({ projectRef: model.projectRef, search }))

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: searchHref(model, search), isReplace: false }),
})

export const init = (route: Route, context: PageContext): Return => {
	const statusKey = requestKey(context.orgId, "integrations.supabaseStatus", {})
	const model: Model = {
		projectRef: route.projectRef,
		search: route.search,
		window: null,
		nowMs: 0,
		status: Keyed.idle(),
		projects: Keyed.idle(),
		timeseries: Keyed.idle(),
		charts: Object.fromEntries(CHART_IDS.map((id) => [id, Chart.init()])),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		timePicker: TimeRangePicker.init("supabase-project-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	const [status, statusFetches] = requestSlot(model.status, statusKey, "Load", () =>
		LoadStatus({ key: statusKey }),
	)
	return {
		model: { ...model, status },
		commands: [
			resolveCommand(model, context, "Load"),
			...statusFetches,
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	if (searchHref(model, model.search) === searchHref(model, route.search)) return { model }
	const next = { ...model, search: route.search }
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

export const contextChanged = (model: Model): Return => ({ model })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, nowMs }, context, window, mode),
		CompletedLoadStatus: ({ key, result }) => ({
			model: { ...model, status: Keyed.accept(model.status, key, result) },
		}),
		CompletedFetchProjects: ({ key, result }) => ({
			model: { ...model, projects: Keyed.accept(model.projects, key, result) },
		}),
		CompletedFetchTimeseries: ({ key, result }) => ({
			model: { ...model, timeseries: Keyed.accept(model.timeseries, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		ClickedRetryTimeseries: () =>
			model.window === null ? { model } : requestAll(model, context, model.window, "Refresh"),
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
				(preset) => searchHref(model, withPreset(model.search, preset)),
			)
			return {
				model: { ...model, timePicker: step.timePicker },
				commands: step.commands,
				outMessage: step.outMessage,
			}
		},
		GotChartMessage: ({ chartId, message: inner }) => {
			const next = Chart.update(model.charts[chartId] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: { ...model.charts, [chartId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ chartId, message: chart }),
				),
			}
		},
	})
