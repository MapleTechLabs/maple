import { bucketSecondsForRange } from "../../../../components/infra/constants"
import { Command } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import * as Frame from "../../kit/frame"
import { liftFrame, resolveFrame, routeFrame } from "../../kit/frame-step"
import { applySteps, keyed, seriesSteps } from "../../kit/requests"
import { FetchSeries, FetchSummary, type SeriesInput } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = Readonly<{ containerName: string; search: Search }>

export const DEFAULT_PRESET = "1h"

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })
const scopeOf = (model: Model, context: PageContext): Frame.Scope => ({
	search: model.search,
	defaultPreset: DEFAULT_PRESET,
	timeZone: context.timeZone,
})

const summaryInputOf = (model: Model, window: { startTime: string; endTime: string }) => ({
	containerName: model.containerName,
	hostName: model.search.host,
	startTime: window.startTime,
	endTime: window.endTime,
})

/** The summary and the selected metric's series; other tabs load when picked. */
const requestAll = (model: Model, context: PageContext, mode: Frame.RequestMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	const summaryInput = summaryInputOf(model, window)
	const input: SeriesInput = {
		containerName: model.containerName,
		hostName: model.search.host,
		metric: model.metric,
		...window,
		bucketSeconds: bucketSecondsForRange(window.startTime, window.endTime),
	}
	const series = seriesSteps(
		model.series,
		[
			{
				id: model.metric,
				key: requestKey(context.orgId, "containerInfraTimeseries", { data: input }),
				fetch: (key: string) => FetchSeries({ key, input }),
			},
		],
		mode,
	)
	return applySteps<Model, Message>(model, [
		keyed(
			model.summary,
			requestKey(context.orgId, "containerDetailSummary", { data: summaryInput }),
			mode,
			(summary) => ({ summary }),
			(key) => FetchSummary({ key, input: summaryInput }),
		),
		{ patch: { series: series.slots }, commands: series.commands },
	])
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.InfraContainer({ containerName: model.containerName, search })),
		isReplace: false,
	}),
})

export const init = (route: Route, context: PageContext): Return => {
	const model: Model = {
		containerName: route.containerName,
		search: route.search,
		frame: Frame.init("infra-container-time-range"),
		metric: "cpu",
		summary: Keyed.idle(),
		series: {},
		charts: {},
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
	}
	return {
		model,
		commands: [
			resolveFrame(model.frame, scopeOf(model, context), toFrame, "Load"),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	const href = (search: Search) =>
		hrefOf(AppRoute.InfraContainer({ containerName: model.containerName, search }))
	if (href(model.search) === href(route.search)) return { model }
	const next = { ...model, search: route.search }
	return routeFrame(model.search, next, scopeOf(next, context), toFrame, (moved, mode) =>
		requestAll(moved, context, mode),
	)
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	requestAll(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchSummary: ({ key, result }) => ({
			model: { ...model, summary: Keyed.accept(model.summary, key, result) },
		}),
		CompletedFetchSeries: ({ metric, key, result }) => {
			const slot = model.series[metric]
			return slot === undefined
				? { model }
				: {
						model: {
							...model,
							series: { ...model.series, [metric]: Keyed.accept(slot, key, result) },
						},
					}
		},
		ClickedMetric: ({ metric }) =>
			metric === model.metric ? { model } : requestAll({ ...model, metric }, context, "Load"),
		ClickedRetrySummary: () => {
			const window = model.frame.window
			if (window === null) return { model }
			const input = summaryInputOf(model, window)
			return applySteps<Model, Message>(model, [
				keyed(
					model.summary,
					requestKey(context.orgId, "containerDetailSummary", { data: input }),
					"Refresh",
					(summary) => ({ summary }),
					(key) => FetchSummary({ key, input }),
				),
			])
		},
		ClickedWidenRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: Frame.WIDEN_TIME_PRESET,
			}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotChartMessage: ({ metric, message: inner }) => {
			const chart = model.charts[metric] ?? Chart.init()
			return {
				model: { ...model, charts: { ...model.charts, [metric]: Chart.update(chart, inner).model } },
			}
		},
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, inner, scopeOf(model, context), toFrame, {
				onResolved: (next, mode) => requestAll(next, context, mode),
				onTimeSearch: (next, search) => navigate(next, { ...next.search, ...search }),
			}),
	})
