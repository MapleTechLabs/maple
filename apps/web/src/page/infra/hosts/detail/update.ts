import { bucketSecondsForRange } from "../../../../components/infra/constants"
import { Command } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import * as Frame from "../../kit/frame"
import { WIDEN_TIME_PRESET } from "../../kit/frame"
import { liftFrame, resolveFrame, routeFrame } from "../../kit/frame-step"
import { applySteps, keyed, seriesSteps } from "../../kit/requests"
import { updateCopy } from "../../kit/resource-attributes"
import { FetchSeries, FetchSummary, type SeriesInput } from "./command"
import { type HostMetric, Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = Readonly<{ hostName: string; search: Search }>

export const DEFAULT_PRESET = "1h"
export const HOST_METRICS: ReadonlyArray<HostMetric> = ["cpu", "memory", "filesystem", "network", "load15"]

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })
const scopeOf = (model: Model, context: PageContext): Frame.Scope => ({
	search: model.search,
	defaultPreset: DEFAULT_PRESET,
	timeZone: context.timeZone,
})

const requestAll = (model: Model, context: PageContext, mode: Frame.RequestMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	const summaryInput = { hostName: model.hostName, startTime: window.startTime, endTime: window.endTime }
	const bucketSeconds = bucketSecondsForRange(window.startTime, window.endTime)
	const series = seriesSteps(
		model.series,
		HOST_METRICS.map((metric) => {
			const input: SeriesInput = { hostName: model.hostName, metric, ...window, bucketSeconds }
			return {
				id: metric,
				key: requestKey(context.orgId, "hostInfraTimeseries", { data: input }),
				fetch: (key: string) => FetchSeries({ key, input }),
			}
		}),
		mode,
	)
	return applySteps<Model, Message>(model, [
		{ patch: { series: series.slots }, commands: series.commands },
		keyed(
			model.summary,
			requestKey(context.orgId, "hostDetailSummary", { data: summaryInput }),
			mode,
			(summary) => ({ summary }),
			(key) => FetchSummary({ key, input: summaryInput }),
		),
	])
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.InfraHost({ hostName: model.hostName, search })),
		isReplace: false,
	}),
})

export const init = (route: Route, context: PageContext): Return => {
	const model: Model = {
		hostName: route.hostName,
		search: route.search,
		frame: Frame.init("infra-host-time-range"),
		summary: Keyed.idle(),
		series: {},
		charts: Object.fromEntries(HOST_METRICS.map((metric) => [metric, Chart.init()])),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		copies: {},
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
	const href = (search: Search) => hrefOf(AppRoute.InfraHost({ hostName: model.hostName, search }))
	if (href(model.search) === href(route.search)) return { model }
	const next = { ...model, search: route.search }
	return routeFrame(model.search, next, scopeOf(next, context), toFrame, (moved, mode) => requestAll(moved, context, mode))
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
		ClickedRetrySummary: () => {
			const window = model.frame.window
			if (window === null) return { model }
			const input = { hostName: model.hostName, startTime: window.startTime, endTime: window.endTime }
			return applySteps<Model, Message>(model, [
				keyed(
					model.summary,
					requestKey(context.orgId, "hostDetailSummary", { data: input }),
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
				timePreset: WIDEN_TIME_PRESET,
			}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedMountLinkedCursor: () => ({ model }),
		GotChartMessage: ({ metric, message: inner }) => {
			const chart = model.charts[metric] ?? Chart.init()
			return {
				model: { ...model, charts: { ...model.charts, [metric]: Chart.update(chart, inner).model } },
			}
		},
		GotCopyMessage: ({ label, message: inner }) => {
			const next = updateCopy(model.copies, label, inner, (l, m) =>
				Message.GotCopyMessage({ label: l, message: m }),
			)
			return { model: { ...model, copies: next.copies }, commands: next.commands }
		},
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, inner, scopeOf(model, context), toFrame, {
				onResolved: (next, mode) => requestAll(next, context, mode),
				onTimeSearch: (next, search) => navigate(next, { ...next.search, ...search }),
			}),
	})
