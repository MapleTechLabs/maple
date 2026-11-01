import { Option } from "effect"
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
import {
	CompleteReloadSpin,
	FetchServices,
	FetchTimeseries,
	FetchTraced,
	ResolveWindow,
	type TimeseriesInput,
} from "./command"
import { Message, type RequestMode } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = { readonly serviceId: string; readonly search: Search }

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
	serviceId: model.serviceId,
	environmentId: model.search.environmentId,
})

const requestAll = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const servicesKey = requestKey(context.orgId, "getRailwayServices", { data: window })
	const input = timeseriesInput(model, window)
	const seriesKey = requestKey(context.orgId, "getRailwayServiceTimeseries", { data: input })
	const services = Keyed.request(model.services, servicesKey, mode)
	const timeseries = Keyed.request(model.timeseries, seriesKey, mode)
	const tracedKey = requestKey(context.orgId, "getServiceOverview", { data: window })
	const traced = Keyed.request(model.traced, tracedKey, mode)
	return {
		model: {
			...model,
			window,
			services: Option.getOrElse(services, () => model.services),
			timeseries: Option.getOrElse(timeseries, () => model.timeseries),
			traced: Option.getOrElse(traced, () => model.traced),
		},
		commands: [
			...(Option.isSome(services) ? [FetchServices({ key: servicesKey, window })] : []),
			...(Option.isSome(timeseries) ? [FetchTimeseries({ key: seriesKey, input })] : []),
			...(Option.isSome(traced) ? [FetchTraced({ key: tracedKey, window })] : []),
		],
	}
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.InfraRailwayService({ serviceId: model.serviceId, search })),
		isReplace: false,
	}),
})

export const CHART_IDS = ["CPU", "Memory", "Network (as reported by Railway)", "Disk"] as const

export const init = (route: Route, context: PageContext): Return => {
	const model: Model = {
		serviceId: route.serviceId,
		search: route.search,
		window: null,
		nowMs: 0,
		services: Keyed.idle(),
		traced: Keyed.idle(),
		timeseries: Keyed.idle(),
		charts: Object.fromEntries(CHART_IDS.map((id) => [id, Chart.init()])),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		timePicker: TimeRangePicker.init("railway-service-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

const searchHref = (model: Model, search: Search) =>
	hrefOf(AppRoute.InfraRailwayService({ serviceId: model.serviceId, search }))

export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	if (searchHref(model, model.search) === searchHref(model, route.search)) return { model }
	const next = { ...model, search: route.search }
	const resolve = (): Return => ({ model: next, commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))] })
	return routeWindowStep(model.search, route.search, {
		resolve,
		requestAll: (mode) => (next.window === null ? resolve() : requestAll(next, context, next.window, mode)),
	})
}

export const contextChanged = (model: Model): Return => ({ model })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, nowMs }, context, window, mode),
		CompletedFetchServices: ({ key, result }) => ({
			model: { ...model, services: Keyed.accept(model.services, key, result) },
		}),
		CompletedFetchTraced: ({ key, result }) => ({
			model: { ...model, traced: Keyed.accept(model.traced, key, result) },
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
		ClickedResetTimeRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted: Return = {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands, (picker) =>
					Message.GotTimePickerMessage({ message: picker }),
				),
			}
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
