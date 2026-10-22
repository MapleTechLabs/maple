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
import { applySteps, keyed, type Step } from "../../kit/requests"
import * as Rail from "../lens/rail"
import type { PodsInput } from "../pod-data"
import { bucketSecondsOf, linkedWorkload } from "./derive"
import { type CpuInput, FetchCpu, FetchLinked, FetchOverview, FetchPods, Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = Readonly<{ search: Search; serviceName?: string }>

export const DEFAULT_PRESET = "12h"
/** Matches the pod table's own page size on the browse route. */
const POD_LIMIT = 50

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })
const toRail = (message: Rail.Message) => Message.GotRailMessage({ message })
const scopeOf = (model: Model, context: PageContext): Frame.Scope => ({
	search: model.search,
	defaultPreset: DEFAULT_PRESET,
	timeZone: context.timeZone,
})

type RequestStep = (
	model: Model,
	context: PageContext,
	window: TimeWindow,
	mode: Frame.RequestMode,
) => Step<Model, Message>

const overviewStep: RequestStep = (model, context, window, mode) => {
	if (model.serviceName === null) return { patch: {}, commands: [] }
	const input = { serviceName: model.serviceName, startTime: window.startTime, endTime: window.endTime }
	return keyed(
		model.overview,
		requestKey(context.orgId, "getServiceDetailOverview", { data: input }),
		mode,
		(overview) => ({ overview }),
		(key) => FetchOverview({ key, input }),
	)
}

/** `listPods` re-keys once the workload lands; until then it asks for the unscoped page. */
const podsStep: RequestStep = (model, context, window, mode) => {
	if (model.serviceName === null) return { patch: {}, commands: [] }
	const workload = linkedWorkload(model)
	const input: PodsInput = {
		startTime: window.startTime,
		endTime: window.endTime,
		workloadKind: workload?.workloadKind,
		workloadName: workload?.workloadName || undefined,
		namespaces: workload?.namespace ? [workload.namespace] : undefined,
		limit: POD_LIMIT,
	}
	return keyed(
		model.pods,
		requestKey(context.orgId, "listPods", { data: input }),
		mode,
		(pods) => ({ pods }),
		(key) => FetchPods({ key, input }),
	)
}

/** The CPU series needs the workload; no request goes out with an empty workload name. */
const cpuStep: RequestStep = (model, context, window, mode) => {
	const workload = linkedWorkload(model)
	if (workload === null) return { patch: {}, commands: [] }
	const input: CpuInput = {
		kind: workload.workloadKind,
		workloadName: workload.workloadName,
		namespace: workload.namespace || undefined,
		metric: "cpu_limit",
		groupByPod: true,
		startTime: window.startTime,
		endTime: window.endTime,
		bucketSeconds: bucketSecondsOf(model, window),
	}
	return keyed(
		model.cpu,
		requestKey(context.orgId, "workloadInfraTimeseries", { data: input }),
		mode,
		(cpu) => ({ cpu }),
		(key) => FetchCpu({ key, input }),
	)
}

/** The requests that follow the workload and the overview's bucket width. */
const follow =
	(context: PageContext) =>
	(result: Return): Return => {
		const window = result.model.frame.window
		if (window === null) return result
		const followed = applySteps<Model, Message>(result.model, [
			podsStep(result.model, context, window, "Load"),
			cpuStep(result.model, context, window, "Load"),
		])
		return {
			...result,
			model: followed.model,
			commands: [...(result.commands ?? []), ...followed.commands],
		}
	}

const requestAll = (model: Model, context: PageContext, mode: Frame.RequestMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	const rail = Rail.request(model.rail, context, window, mode)
	const withRail = { ...model, rail: rail.model }
	const serviceName = model.serviceName
	if (serviceName === null) return { model: withRail, commands: Command.mapMessages(rail.commands, toRail) }
	const linkedInput = { services: [serviceName], startTime: window.startTime, endTime: window.endTime }
	const own = applySteps<Model, Message>(withRail, [
		keyed(
			model.linked,
			requestKey(context.orgId, "getServiceWorkloads", { data: linkedInput }),
			mode,
			(linked) => ({ linked }),
			(key) => FetchLinked({ key, input: linkedInput }),
		),
		overviewStep(model, context, window, mode),
		podsStep(model, context, window, mode),
		cpuStep(model, context, window, mode),
	])
	return { model: own.model, commands: [...Command.mapMessages(rail.commands, toRail), ...own.commands] }
}

const retry = (model: Model, context: PageContext, step: RequestStep): Return =>
	model.frame.window === null
		? { model }
		: applySteps<Model, Message>(model, [step(model, context, model.frame.window, "Refresh")])

export const init = (route: Route, context: PageContext): Return => {
	const model: Model = {
		serviceName: route.serviceName ?? null,
		search: route.search,
		frame: Frame.init("infra-lens-time-range"),
		rail: Rail.init(),
		linked: Keyed.idle(),
		overview: Keyed.idle(),
		cpu: Keyed.idle(),
		pods: Keyed.idle(),
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

/** The lens URL: the picked service's page, or the section index with nothing picked. */
const lensHref = (serviceName: string | null, search: Search) =>
	serviceName === null
		? hrefOf(AppRoute.InfraKubernetesServices({ search }))
		: hrefOf(AppRoute.InfraKubernetesService({ serviceName, search }))

/** A pick keeps the rail and starts the lens body afresh. */
export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	const serviceName = route.serviceName ?? null
	if (lensHref(model.serviceName, model.search) === lensHref(serviceName, route.search)) return { model }
	const next: Model =
		serviceName === model.serviceName
			? { ...model, search: route.search }
			: {
					...model,
					serviceName,
					search: route.search,
					linked: Keyed.idle(),
					overview: Keyed.idle(),
					cpu: Keyed.idle(),
					pods: Keyed.idle(),
					charts: {},
				}
	return routeFrame(model.search, next, scopeOf(next, context), toFrame, (moved, mode) =>
		requestAll(moved, context, mode),
	)
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	requestAll(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchLinked: ({ key, result }) =>
			follow(context)({ model: { ...model, linked: Keyed.accept(model.linked, key, result) } }),
		CompletedFetchOverview: ({ key, result }) =>
			follow(context)({ model: { ...model, overview: Keyed.accept(model.overview, key, result) } }),
		CompletedFetchCpu: ({ key, result }) => ({
			model: { ...model, cpu: Keyed.accept(model.cpu, key, result) },
		}),
		CompletedFetchPods: ({ key, result }) => ({
			model: { ...model, pods: Keyed.accept(model.pods, key, result) },
		}),
		ClickedRetryOverview: () => retry(model, context, overviewStep),
		ClickedRetryPods: () => retry(model, context, podsStep),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedMountLinkedCursor: () => ({ model }),
		GotChartMessage: ({ id, message: inner }) => {
			const chart = model.charts[id] ?? Chart.init()
			return {
				model: { ...model, charts: { ...model.charts, [id]: Chart.update(chart, inner).model } },
			}
		},
		GotRailMessage: ({ message: inner }) => {
			const next = Rail.update(model.rail, inner, context, model.frame.window)
			return {
				model: { ...model, rail: next.model },
				commands: Command.mapMessages(next.commands, toRail),
			}
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
		url: lensHref(model.serviceName, search),
		isReplace: false,
	}),
})
