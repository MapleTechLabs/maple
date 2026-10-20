import { AsyncData, Command } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { Resources } from "../../../../platform/resources"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import { DEFAULT_PRESET, DEPLOYMENTS_LIMIT, seriesInput } from "../data"
import { AI_GATEWAY_CHART_IDS } from "../view-parts"
import {
	CompleteReloadSpin,
	FetchAiGateway,
	FetchBuckets,
	FetchDeployments,
	FetchDetail,
	FetchProjects,
	LoadStatus,
	ResolveWindow,
} from "./command"
import { Message, type Model, type RequestMode } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = { readonly projectId: string; readonly search: Search }
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

export const CHART_IDS = ["vercel-status", "vercel-cache", "vercel-errors", ...AI_GATEWAY_CHART_IDS] as const

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const hrefOfSearch = (model: Model, search: Search) =>
	hrefOf(AppRoute.InfraVercelProject({ projectId: model.projectId, search }))

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOfSearch(model, search), isReplace: false }),
})

type Slot = "requests" | "detail" | "deployments" | "aiGateway"

/** Every read the page makes; the window's wait for it, the deployments only for the project. */
const sync = (
	model: Model,
	context: PageContext,
	mode: Keyed.RequestMode,
	only?: ReadonlyArray<Slot>,
): Return => {
	const org = context.orgId
	const { projectId } = model
	const commands: Array<Commands[number]> = []
	const take = <A, E>(
		slot: Slot,
		current: Keyed.Keyed<A, E>,
		key: string,
		fetch: () => Commands[number],
	) => {
		if (only !== undefined && !only.includes(slot)) return current
		const [next, fetches] = requestSlot(current, key, mode, fetch)
		commands.push(...fetches)
		return next
	}
	const deploymentsKey = requestKey(org, "integrations.vercelDeployments", {
		projectId,
		limit: DEPLOYMENTS_LIMIT,
	})
	const withDeployments: Model = {
		...model,
		deployments: take("deployments", model.deployments, deploymentsKey, () =>
			FetchDeployments({ key: deploymentsKey, projectId }),
		),
	}
	const window = model.window
	if (window === null) return { model: withDeployments, commands }
	const series = { ...seriesInput(window), projectId }
	const detailInput = { startTime: window.startTime, endTime: window.endTime, projectId }
	const projectsKey = requestKey(org, "getVercelProjects", { data: window })
	const bucketsKey = requestKey(org, "getVercelRequestTimeseries", { data: series })
	const detailKey = requestKey(org, "getVercelProjectDetail", { data: detailInput })
	const aiKey = requestKey(org, "getVercelAiGateway", { data: series })
	return {
		model: {
			...withDeployments,
			projects: take("requests", model.projects, projectsKey, () =>
				FetchProjects({ key: projectsKey, window }),
			),
			buckets: take("requests", model.buckets, bucketsKey, () =>
				FetchBuckets({ key: bucketsKey, input: series }),
			),
			detail: take("detail", model.detail, detailKey, () =>
				FetchDetail({ key: detailKey, input: detailInput }),
			),
			aiGateway: take("aiGateway", model.aiGateway, aiKey, () =>
				FetchAiGateway({ key: aiKey, input: series }),
			),
		},
		commands,
	}
}

export const init = (route: Route, context: PageContext): Return => {
	const statusKey = requestKey(context.orgId, "integrations.vercelStatus", {})
	const model: Model = {
		projectId: route.projectId,
		search: route.search,
		window: null,
		nowMs: 0,
		status: { key: statusKey, data: AsyncData.Loading() },
		projects: Keyed.idle(),
		buckets: Keyed.idle(),
		detail: Keyed.idle(),
		deployments: Keyed.idle(),
		aiGateway: Keyed.idle(),
		charts: Object.fromEntries(CHART_IDS.map((id) => [id, Chart.init()])),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		timePicker: TimeRangePicker.init("vercel-project-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	const deployments = sync(model, context, "Load")
	return {
		model: deployments.model,
		commands: [
			resolveCommand(model, context, "Load"),
			LoadStatus({ key: statusKey }),
			...(deployments.commands ?? []),
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
	return routeWindowStep(model.search, route.search, {
		resolve: (): Return => ({
			model: next,
			commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
		}),
		requestAll: (mode) => sync(next, context, mode),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return => sync(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) => sync({ ...model, window, nowMs }, context, mode),
		CompletedLoadStatus: ({ key, result }) => ({
			model: { ...model, status: Keyed.accept(model.status, key, result) },
		}),
		CompletedFetchProjects: ({ key, result }) => ({
			model: { ...model, projects: Keyed.accept(model.projects, key, result) },
		}),
		CompletedFetchBuckets: ({ key, result }) => ({
			model: { ...model, buckets: Keyed.accept(model.buckets, key, result) },
		}),
		CompletedFetchDetail: ({ key, result }) => ({
			model: { ...model, detail: Keyed.accept(model.detail, key, result) },
		}),
		CompletedFetchDeployments: ({ key, result }) => ({
			model: { ...model, deployments: Keyed.accept(model.deployments, key, result) },
		}),
		CompletedFetchAiGateway: ({ key, result }) => ({
			model: { ...model, aiGateway: Keyed.accept(model.aiGateway, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		ClickedRetryRequests: () => sync(model, context, "Refresh", ["requests"]),
		ClickedRetryDetail: () => sync(model, context, "Refresh", ["detail"]),
		ClickedRetryDeployments: () => sync(model, context, "Refresh", ["deployments"]),
		ClickedRetryAiGateway: () => sync(model, context, "Refresh", ["aiGateway"]),
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
