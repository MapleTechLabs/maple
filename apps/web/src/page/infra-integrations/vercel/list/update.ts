import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import type { VercelIntegrationStatus } from "@maple/domain/http"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import type { Resources } from "../../../../platform/resources"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { nextSort } from "../../../kit/table-sort"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import { DEFAULT_PRESET, DEPLOYMENTS_LIMIT, seriesInput } from "../data"
import {
	CompleteReloadSpin,
	FetchAiGateway,
	FetchAuditLog,
	FetchBuckets,
	FetchDeployments,
	FetchProjects,
	FetchSpeedInsights,
	FetchWebAnalytics,
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

const connectedStatus = (model: Model): VercelIntegrationStatus | null =>
	Option.getOrNull(Option.filter(AsyncData.getData(model.status.data), (status) => status.connected))

export const isConnected = (model: Model): boolean => connectedStatus(model) !== null

/** The projects list; anything else (including the retired `aiGateway`) is the overview. */
export const isProjectsView = (search: Search): boolean => search.view === "projects"

type Slot =
	| "projects"
	| "buckets"
	| "aiGateway"
	| "deployments"
	| "speedInsights"
	| "webAnalytics"
	| "auditLog"

/**
 * The reads the view shows, once the status says connected. The overview reads every section whose
 * drain is on; the projects list only the projects.
 */
const sync = (
	model: Model,
	context: PageContext,
	mode: Keyed.RequestMode,
	only?: ReadonlyArray<Slot>,
): Return => {
	const window = model.window
	const status = connectedStatus(model)
	if (window === null || status === null) return { model }
	const org = context.orgId
	const overview = !isProjectsView(model.search)
	const series = seriesInput(window)
	const commands: Array<Commands[number]> = []
	const take = <A, E>(
		slot: Slot,
		shown: boolean,
		current: Keyed.Keyed<A, E>,
		key: string,
		fetch: () => Commands[number],
	) => {
		if (!shown || (only !== undefined && !only.includes(slot))) return current
		const [next, fetches] = requestSlot(current, key, mode, fetch)
		commands.push(...fetches)
		return next
	}
	const projectsKey = requestKey(org, "getVercelProjects", { data: window })
	const bucketsKey = requestKey(org, "getVercelRequestTimeseries", { data: series })
	const aiKey = requestKey(org, "getVercelAiGateway", { data: series })
	const deploymentsKey = requestKey(org, "integrations.vercelDeployments", { limit: DEPLOYMENTS_LIMIT })
	const speedKey = requestKey(org, "getVercelSpeedInsights", { data: window })
	const webKey = requestKey(org, "getVercelWebAnalytics", { data: window })
	const auditKey = requestKey(org, "getVercelAuditLog", { data: window })
	return {
		model: {
			...model,
			projects: take("projects", true, model.projects, projectsKey, () =>
				FetchProjects({ key: projectsKey, window }),
			),
			buckets: take("buckets", overview, model.buckets, bucketsKey, () =>
				FetchBuckets({ key: bucketsKey, input: series }),
			),
			aiGateway: take("aiGateway", overview && status.aiGatewayEnabled, model.aiGateway, aiKey, () =>
				FetchAiGateway({ key: aiKey, input: series }),
			),
			deployments: take("deployments", overview, model.deployments, deploymentsKey, () =>
				FetchDeployments({ key: deploymentsKey }),
			),
			speedInsights: take(
				"speedInsights",
				overview && status.speedInsightsEnabled,
				model.speedInsights,
				speedKey,
				() => FetchSpeedInsights({ key: speedKey, input: window }),
			),
			webAnalytics: take(
				"webAnalytics",
				overview && status.webAnalyticsEnabled,
				model.webAnalytics,
				webKey,
				() => FetchWebAnalytics({ key: webKey, input: window }),
			),
			auditLog: take("auditLog", overview && status.auditLogEnabled, model.auditLog, auditKey, () =>
				FetchAuditLog({ key: auditKey, window }),
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
		deployments: Keyed.idle(),
		speedInsights: Keyed.idle(),
		webAnalytics: Keyed.idle(),
		auditLog: Keyed.idle(),
		sort: { key: "requests", dir: "desc" },
		timePicker: TimeRangePicker.init("vercel-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	const status = loadStatus(model, context)
	return {
		model: status.model,
		commands: [resolveCommand(model, context, "Load"), ...(status.commands ?? [])],
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
		// A new view may show reads the old one did not.
		requestAll: (mode): Return => sync(next, context, mode),
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
		CompletedFetchDeployments: ({ key, result }) => ({
			model: { ...model, deployments: Keyed.accept(model.deployments, key, result) },
		}),
		CompletedFetchSpeedInsights: ({ key, result }) => ({
			model: { ...model, speedInsights: Keyed.accept(model.speedInsights, key, result) },
		}),
		CompletedFetchWebAnalytics: ({ key, result }) => ({
			model: { ...model, webAnalytics: Keyed.accept(model.webAnalytics, key, result) },
		}),
		CompletedFetchAuditLog: ({ key, result }) => ({
			model: { ...model, auditLog: Keyed.accept(model.auditLog, key, result) },
		}),
		TickedEmptyRefresh: () => sync(model, context, "Refresh", ["projects", "buckets"]),
		ClickedRetryStatus: () => loadStatus(model, context),
		ClickedRetryProjects: () => sync(model, context, "Refresh", ["projects"]),
		ClickedRetryBuckets: () => sync(model, context, "Refresh", ["buckets"]),
		ClickedRetryAiGateway: () => sync(model, context, "Refresh", ["aiGateway"]),
		ClickedRetryDeployments: () => sync(model, context, "Refresh", ["deployments"]),
		ClickedRetrySpeedInsights: () => sync(model, context, "Refresh", ["speedInsights"]),
		ClickedRetryWebAnalytics: () => sync(model, context, "Refresh", ["webAnalytics"]),
		ClickedRetryAuditLog: () => sync(model, context, "Refresh", ["auditLog"]),
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
	})
