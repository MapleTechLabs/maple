import { AWS_INFRA_KIND_IDS, type AwsInfraKindId } from "@maple/domain/aws-infra"
import { Command } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import { keysOf } from "../derive"
import { chartIds } from "./charts"
import { CompleteReloadSpin, FetchTimeseries, FetchTraced, ResolveWindow } from "./command"
import { Message, type RequestMode } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = { readonly kind: string; readonly name: string; readonly search: Search }

export const DEFAULT_PRESET = "6h"

const isKind = (kind: string): kind is AwsInfraKindId => AWS_INFRA_KIND_IDS.some((id) => id === kind)

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const request = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = model.window
	const kind = model.kind
	if (window === null || kind === null) return { model }
	const input = {
		startTime: window.startTime,
		endTime: window.endTime,
		bucketSeconds: chartBucketSeconds(window.startTime, window.endTime),
		kind,
		keys: keysOf(kind, model.name, model.search),
	}
	const seriesKey = requestKey(context.orgId, "getAwsInfraTimeseries", { data: input })
	const tracedKey = requestKey(context.orgId, "getServiceOverview", { data: window })
	const [timeseries, seriesFetches] = requestSlot(model.timeseries, seriesKey, mode, () =>
		FetchTimeseries({ key: seriesKey, input }),
	)
	// Only an ECS service or a Lambda function runs as a traced service.
	const [traced, tracedFetches] =
		kind === "ecs" || kind === "lambda"
			? requestSlot(model.traced, tracedKey, mode, () => FetchTraced({ key: tracedKey, window }))
			: ([model.traced, []] as const)
	return { model: { ...model, timeseries, traced }, commands: [...seriesFetches, ...tracedFetches] }
}

const searchHref = (model: Model, search: Search) =>
	hrefOf(AppRoute.InfraAwsResource({ kind: model.kind ?? "", name: model.name, search }))

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: searchHref(model, search), isReplace: false }),
})

export const init = (route: Route, context: PageContext): Return => {
	const kind = isKind(route.kind) ? route.kind : null
	const model: Model = {
		kind,
		name: route.name,
		search: route.search,
		window: null,
		nowMs: 0,
		timeseries: Keyed.idle(),
		traced: Keyed.idle(),
		charts: Object.fromEntries((kind === null ? [] : chartIds(kind)).map((id) => [id, Chart.init()])),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		timePicker: TimeRangePicker.init("aws-resource-time-range"),
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

export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	if (searchHref(model, model.search) === searchHref(model, route.search)) return { model }
	const next = { ...model, search: route.search }
	return routeWindowStep(model.search, route.search, {
		resolve: (): Return => ({
			model: next,
			commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
		}),
		requestAll: (): Return => request(next, context, "Load"),
	})
}

export const contextChanged = (model: Model): Return => ({ model })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			request({ ...model, window, nowMs }, context, mode),
		CompletedFetchTimeseries: ({ key, result }) => ({
			model: { ...model, timeseries: Keyed.accept(model.timeseries, key, result) },
		}),
		CompletedFetchTraced: ({ key, result }) => ({
			model: { ...model, traced: Keyed.accept(model.traced, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		ClickedRetry: () => request(model, context, "Refresh"),
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
