import { Option } from "effect"
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
import { nextSort } from "../../../kit/table-sort"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import { DEFAULT_PRESET, seriesInput } from "../data"
import { AI_GATEWAY_CHART_IDS } from "../view-parts"
import {
	CompleteReloadSpin,
	FetchAiGateway,
	FetchBuckets,
	FetchProjects,
	LoadStatus,
	ResolveWindow,
} from "./command"
import { Message, type Model, type RequestMode } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const hrefOfSearch = (search: Search) => hrefOf(AppRoute.InfraVercel({ search }))

/** The view, search and time range are written in place, like `navigate({ search })`. */
const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOfSearch(search), isReplace: false }),
})

const statusKey = (context: PageContext) => requestKey(context.orgId, "integrations.vercelStatus", {})

export const isConnected = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.status.data), {
		onNone: () => false,
		onSome: (status) => status.connected,
	})

type Slot = "projects" | "buckets" | "aiGateway"

/** `VercelConnected` mounts once the status says connected: projects, the fleet series and AI Gateway. */
const sync = (
	model: Model,
	context: PageContext,
	mode: Keyed.RequestMode,
	only?: ReadonlyArray<Slot>,
): Return => {
	const window = model.window
	if (window === null || !isConnected(model)) return { model }
	const org = context.orgId
	const series = seriesInput(window)
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
	const projectsKey = requestKey(org, "getVercelProjects", { data: window })
	const bucketsKey = requestKey(org, "getVercelRequestTimeseries", { data: series })
	const aiKey = requestKey(org, "getVercelAiGateway", { data: series })
	return {
		model: {
			...model,
			projects: take("projects", model.projects, projectsKey, () =>
				FetchProjects({ key: projectsKey, window }),
			),
			buckets: take("buckets", model.buckets, bucketsKey, () =>
				FetchBuckets({ key: bucketsKey, input: series }),
			),
			aiGateway: take("aiGateway", model.aiGateway, aiKey, () =>
				FetchAiGateway({ key: aiKey, input: series }),
			),
		},
		commands,
	}
}

const loadStatus = (model: Model, context: PageContext): Return => {
	const key = statusKey(context)
	return {
		model: { ...model, status: { key, data: AsyncData.Loading() } },
		commands: [LoadStatus({ key })],
	}
}

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		status: Keyed.idle(),
		projects: Keyed.idle(),
		buckets: Keyed.idle(),
		aiGateway: Keyed.idle(),
		sort: { key: "requests", dir: "desc" },
		charts: Object.fromEntries(AI_GATEWAY_CHART_IDS.map((id) => [id, Chart.init()])),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		timePicker: TimeRangePicker.init("vercel-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	const status = loadStatus(model, context)
	return {
		model: status.model,
		commands: [
			resolveCommand(model, context, "Load"),
			...(status.commands ?? []),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (hrefOfSearch(model.search) === hrefOfSearch(route.search)) return { model }
	const next = { ...model, search: route.search }
	return routeWindowStep(model.search, route.search, {
		resolve: (): Return => ({
			model: next,
			commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
		}),
		requestAll: (): Return => ({ model: next }),
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
		CompletedFetchAiGateway: ({ key, result }) => ({
			model: { ...model, aiGateway: Keyed.accept(model.aiGateway, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		TickedEmptyRefresh: ({ slot }) =>
			sync(model, context, "Refresh", slot === "projects" ? ["projects", "buckets"] : ["aiGateway"]),
		ClickedRetryStatus: () => loadStatus(model, context),
		ClickedRetryProjects: () => sync(model, context, "Refresh", ["projects"]),
		ClickedRetryBuckets: () => sync(model, context, "Refresh", ["buckets"]),
		ClickedRetryAiGateway: () => sync(model, context, "Refresh", ["aiGateway"]),
		ClickedView: ({ view }) =>
			navigate(model, { ...model.search, view: view === "projects" ? undefined : view }),
		ChangedSearch: ({ value }) =>
			navigate(model, { ...model.search, q: value === "" ? undefined : value }),
		ClickedClearSearch: () => navigate(model, { ...model.search, q: undefined }),
		ClickedSort: ({ key }) => ({
			model: { ...model, sort: nextSort(model.sort, key, { stringKeys: ["name"] }) },
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
				(preset) => hrefOfSearch(withPreset(model.search, preset)),
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
