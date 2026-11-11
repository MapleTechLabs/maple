import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "@maple/views/charts/chart"
import { LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import type { Resources } from "../../../../platform/resources"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import { type BreakdownInput, DEFAULT_PRESET, DEPLOYMENTS_LIMIT, seriesInput } from "../data"
import type { VercelIntegrationStatus } from "@maple/domain/http"
import type { VercelBreakdownBy, VercelProjectTab } from "../../../../route/search"
import {
	CompleteReloadSpin,
	FetchAiGateway,
	FetchBreakdown,
	FetchBuckets,
	FetchDependencies,
	FetchDeployments,
	FetchDetail,
	FetchFunctions,
	FetchLatency,
	FetchProjects,
	FetchSpeedInsights,
	FetchWebAnalytics,
	LoadStatus,
	ResolveWindow,
} from "./command"
import { Message, type Model, type RequestMode } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = { readonly projectId: string; readonly search: Search }
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

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

type Slot =
	| "projects"
	| "buckets"
	| "latency"
	| "breakdown"
	| "detail"
	| "deployments"
	| "aiGateway"
	| "functions"
	| "dependencies"
	| "speedInsights"
	| "webAnalytics"

export const tabOf = (model: Model): VercelProjectTab => {
	switch (model.search.tab) {
		case undefined:
			return "traffic"
		case "dependencies":
			return "functions"
		case "speedInsights":
		case "webAnalytics":
			return "users"
		default:
			return model.search.tab
	}
}

export const breakdownByOf = (model: Model): VercelBreakdownBy => model.search.by ?? "path"

/** The rail's reads, on every tab: the header's row, functions, outbound calls and builds. */
const RAIL_SLOTS: ReadonlyArray<Slot> = ["projects", "functions", "dependencies", "deployments"]

/** What each tab shows beside the rail; a drain-fed read waits for the status to say its drain is on. */
const TAB_SLOTS = {
	traffic: ["buckets", "latency", "breakdown", "detail"],
	functions: [],
	builds: [],
	users: ["speedInsights", "webAnalytics"],
	aiGateway: ["aiGateway"],
} satisfies Record<VercelProjectTab, ReadonlyArray<Slot>>

const drainOn = (slot: Slot, status: VercelIntegrationStatus | null): boolean => {
	switch (slot) {
		case "functions":
		case "dependencies":
		case "latency":
			return status?.tracesEnabled === true
		case "aiGateway":
			return status?.aiGatewayEnabled === true
		case "speedInsights":
			return status?.speedInsightsEnabled === true
		case "webAnalytics":
			return status?.webAnalyticsEnabled === true
		default:
			return true
	}
}

/** The rail's and the active tab's reads; the window's wait for it, the deployments only for the project. */
const sync = (
	model: Model,
	context: PageContext,
	mode: Keyed.RequestMode,
	only?: ReadonlyArray<Slot>,
): Return => {
	const org = context.orgId
	const { projectId } = model
	const status = Option.getOrNull(AsyncData.getData(model.status.data))
	const shown: ReadonlyArray<Slot> = [...RAIL_SLOTS, ...TAB_SLOTS[tabOf(model)]]
	const commands: Array<Commands[number]> = []
	const take = <A, E>(
		slot: Slot,
		current: Keyed.Keyed<A, E>,
		key: string,
		fetch: () => Commands[number],
	) => {
		if (!shown.includes(slot) || !drainOn(slot, status)) return current
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
	const dimension = breakdownByOf(model)
	const narrowed = model.search.status
	const breakdownInput: BreakdownInput =
		narrowed === undefined
			? { ...detailInput, dimension }
			: { ...detailInput, dimension, status: narrowed }
	const latencyKey = requestKey(org, "getVercelLatencyTimeseries", { data: series })
	const breakdownKey = requestKey(org, "getVercelBreakdown", { data: breakdownInput })
	const detailKey = requestKey(org, "getVercelProjectDetail", { data: detailInput })
	const aiKey = requestKey(org, "getVercelAiGateway", { data: series })
	const functionsKey = requestKey(org, "getVercelFunctions", { data: detailInput })
	const dependenciesKey = requestKey(org, "getVercelDependencies", { data: detailInput })
	const speedKey = requestKey(org, "getVercelSpeedInsights", { data: detailInput })
	const webKey = requestKey(org, "getVercelWebAnalytics", { data: detailInput })
	return {
		model: {
			...withDeployments,
			projects: take("projects", model.projects, projectsKey, () =>
				FetchProjects({ key: projectsKey, window }),
			),
			buckets: take("buckets", model.buckets, bucketsKey, () =>
				FetchBuckets({ key: bucketsKey, input: series }),
			),
			latency: take("latency", model.latency, latencyKey, () =>
				FetchLatency({ key: latencyKey, input: series }),
			),
			breakdown: take("breakdown", model.breakdown, breakdownKey, () =>
				FetchBreakdown({ key: breakdownKey, input: breakdownInput }),
			),
			detail: take("detail", model.detail, detailKey, () =>
				FetchDetail({ key: detailKey, input: detailInput }),
			),
			aiGateway: take("aiGateway", model.aiGateway, aiKey, () =>
				FetchAiGateway({ key: aiKey, input: series }),
			),
			functions: take("functions", model.functions, functionsKey, () =>
				FetchFunctions({ key: functionsKey, input: detailInput }),
			),
			dependencies: take("dependencies", model.dependencies, dependenciesKey, () =>
				FetchDependencies({ key: dependenciesKey, input: detailInput }),
			),
			speedInsights: take("speedInsights", model.speedInsights, speedKey, () =>
				FetchSpeedInsights({ key: speedKey, input: detailInput }),
			),
			webAnalytics: take("webAnalytics", model.webAnalytics, webKey, () =>
				FetchWebAnalytics({ key: webKey, input: detailInput }),
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
		latency: Keyed.idle(),
		breakdown: Keyed.idle(),
		detail: Keyed.idle(),
		deployments: Keyed.idle(),
		aiGateway: Keyed.idle(),
		functions: Keyed.idle(),
		dependencies: Keyed.idle(),
		speedInsights: Keyed.idle(),
		webAnalytics: Keyed.idle(),
		charts: {},
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
		CompletedLoadStatus: ({ key, result }) =>
			sync({ ...model, status: Keyed.accept(model.status, key, result) }, context, "Load"),
		CompletedFetchProjects: ({ key, result }) => ({
			model: { ...model, projects: Keyed.accept(model.projects, key, result) },
		}),
		CompletedFetchBuckets: ({ key, result }) => ({
			model: { ...model, buckets: Keyed.accept(model.buckets, key, result) },
		}),
		CompletedFetchLatency: ({ key, result }) => ({
			model: { ...model, latency: Keyed.accept(model.latency, key, result) },
		}),
		CompletedFetchBreakdown: ({ key, result }) => ({
			model: { ...model, breakdown: Keyed.accept(model.breakdown, key, result) },
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
		CompletedFetchFunctions: ({ key, result }) => ({
			model: { ...model, functions: Keyed.accept(model.functions, key, result) },
		}),
		CompletedFetchDependencies: ({ key, result }) => ({
			model: { ...model, dependencies: Keyed.accept(model.dependencies, key, result) },
		}),
		CompletedFetchSpeedInsights: ({ key, result }) => ({
			model: { ...model, speedInsights: Keyed.accept(model.speedInsights, key, result) },
		}),
		CompletedFetchWebAnalytics: ({ key, result }) => ({
			model: { ...model, webAnalytics: Keyed.accept(model.webAnalytics, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		ClickedRetryRequests: () => sync(model, context, "Refresh", ["projects", "buckets", "latency"]),
		ClickedRetryDetail: () => sync(model, context, "Refresh", ["detail"]),
		ClickedRetryBreakdown: () => sync(model, context, "Refresh", ["breakdown"]),
		ClickedBreakdownBy: ({ by }) =>
			navigate(model, { ...model.search, by: by === "path" ? undefined : by }),
		ClickedBreakdownStatus: ({ status }) =>
			navigate(model, { ...model.search, status: status ?? undefined }),
		AttachedLinkedCursor: () => ({ model }),
		ClickedRetryDeployments: () => sync(model, context, "Refresh", ["deployments"]),
		ClickedRetryAiGateway: () => sync(model, context, "Refresh", ["aiGateway"]),
		ClickedRetryFunctions: () => sync(model, context, "Refresh", ["functions"]),
		ClickedRetryDependencies: () => sync(model, context, "Refresh", ["dependencies"]),
		ClickedRetrySpeedInsights: () => sync(model, context, "Refresh", ["speedInsights"]),
		ClickedRetryWebAnalytics: () => sync(model, context, "Refresh", ["webAnalytics"]),
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
