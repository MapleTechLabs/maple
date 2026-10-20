import { bucketSecondsForRange } from "../../../../components/infra/constants"
import { Command } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import * as Frame from "../../kit/frame"
import { liftFrame, resolveFrame, routeFrame } from "../../kit/frame-step"
import { applySteps, keyed, seriesSteps, type Step } from "../../kit/requests"
import type { PodsInput } from "../pod-data"
import { FetchPods, FetchSeries, FetchSummary, Message, type SeriesInput } from "./message"
import { type Model, seriesId, type WorkloadKind } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = Readonly<{ kind: WorkloadKind; workloadName: string; search: Search }>

export const DEFAULT_PRESET = "1h"

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })
const scopeOf = (model: Model, context: PageContext): Frame.Scope => ({
	search: model.search,
	defaultPreset: DEFAULT_PRESET,
	timeZone: context.timeZone,
})

type RequestStep = (model: Model, context: PageContext, window: TimeWindow, mode: Frame.RequestMode) => Step<Model, Message>

const summaryStep: RequestStep = (model, context, window, mode) => {
	const input = {
		kind: model.kind,
		workloadName: model.workloadName,
		namespace: model.search.namespace,
		startTime: window.startTime,
		endTime: window.endTime,
	}
	return keyed(
		model.summary,
		requestKey(context.orgId, "workloadDetailSummary", { data: input }),
		mode,
		(summary) => ({ summary }),
		(key) => FetchSummary({ key, input }),
	)
}

const podsStep: RequestStep = (model, context, window, mode) => {
	const namespace = model.search.namespace
	const input: PodsInput = {
		workloadKind: model.kind,
		workloadName: model.workloadName,
		namespaces: namespace ? [namespace] : undefined,
		startTime: window.startTime,
		endTime: window.endTime,
		limit: 200,
	}
	return keyed(
		model.pods,
		requestKey(context.orgId, "listPods", { data: input }),
		mode,
		(pods) => ({ pods }),
		(key) => FetchPods({ key, input }),
	)
}

const seriesStep: RequestStep = (model, context, window, mode) => {
	const input: SeriesInput = {
		kind: model.kind,
		workloadName: model.workloadName,
		namespace: model.search.namespace,
		metric: model.metric,
		groupByPod: model.groupByPod,
		startTime: window.startTime,
		endTime: window.endTime,
		bucketSeconds: bucketSecondsForRange(window.startTime, window.endTime),
	}
	const id = seriesId(model)
	const series = seriesSteps(
		model.series,
		[
			{
				id,
				key: requestKey(context.orgId, "workloadInfraTimeseries", { data: input }),
				fetch: (key: string) => FetchSeries({ id, key, input }),
			},
		],
		mode,
	)
	return { patch: { series: series.slots }, commands: series.commands }
}

const requestAll = (model: Model, context: PageContext, mode: Frame.RequestMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	return applySteps<Model, Message>(model, [
		summaryStep(model, context, window, mode),
		podsStep(model, context, window, mode),
		seriesStep(model, context, window, mode),
	])
}

const retry = (model: Model, context: PageContext, step: RequestStep): Return =>
	model.frame.window === null ? { model } : applySteps<Model, Message>(model, [step(model, context, model.frame.window, "Refresh")])

export const init = (route: Route, context: PageContext): Return => {
	const model: Model = {
		kind: route.kind,
		workloadName: route.workloadName,
		search: route.search,
		frame: Frame.init("infra-workload-time-range"),
		metric: "cpu_limit",
		groupByPod: true,
		summary: Keyed.idle(),
		pods: Keyed.idle(),
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
		hrefOf(AppRoute.InfraKubernetesWorkload({ kind: model.kind, workloadName: model.workloadName, search }))
	if (href(model.search) === href(route.search)) return { model }
	const next = { ...model, search: route.search }
	return routeFrame(model.search, next, scopeOf(next, context), toFrame, (moved, mode) => requestAll(moved, context, mode))
}

export const contextChanged = (model: Model, context: PageContext): Return => requestAll(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchSummary: ({ key, result }) => ({
			model: { ...model, summary: Keyed.accept(model.summary, key, result) },
		}),
		CompletedFetchPods: ({ key, result }) => ({ model: { ...model, pods: Keyed.accept(model.pods, key, result) } }),
		CompletedFetchSeries: ({ id, key, result }) => {
			const slot = model.series[id]
			return slot === undefined
				? { model }
				: { model: { ...model, series: { ...model.series, [id]: Keyed.accept(slot, key, result) } } }
		},
		ClickedMetric: ({ metric }) =>
			metric === model.metric ? { model } : requestAll({ ...model, metric }, context, "Load"),
		ToggledGroupByPod: ({ isChecked }) => requestAll({ ...model, groupByPod: isChecked }, context, "Load"),
		ClickedRetrySummary: () => retry(model, context, summaryStep),
		ClickedRetryPods: () => retry(model, context, podsStep),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({ model: { ...model, chartRuntime: { _tag: "Failed", reason } } }),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotChartMessage: ({ metric, message: inner }) => {
			const chart = model.charts[metric] ?? Chart.init()
			return { model: { ...model, charts: { ...model.charts, [metric]: Chart.update(chart, inner).model } } }
		},
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, inner, scopeOf(model, context), toFrame, {
				onResolved: (next, mode) => requestAll(next, context, mode),
				onTimeSearch: (next, search) => navigate(next, { ...next.search, ...search }),
			}),
	})

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.InfraKubernetesWorkload({ kind: model.kind, workloadName: model.workloadName, search })),
		isReplace: false,
	}),
})
