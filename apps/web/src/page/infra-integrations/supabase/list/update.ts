import { Option, Result } from "effect"
import { AsyncData } from "foldkit"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import { FLEET_INSIGHTS_LIMIT } from "../data"
import type { SupabaseStatus } from "../model"
import {
	CompleteReloadSpin,
	FetchInsights,
	FetchIssues,
	FetchProjects,
	LoadStatus,
	ResolveWindow,
} from "./command"
import { Message, type RequestMode } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]

export const DEFAULT_PRESET = "6h"

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const statusKey = (context: PageContext) => requestKey(context.orgId, "integrations.supabaseStatus", {})

const connectedStatus = (model: Model): SupabaseStatus | null =>
	Option.match(AsyncData.getData(model.status.data), {
		onNone: () => null,
		onSome: (status) => (status.connected ? status : null),
	})

const insightRefs = (status: SupabaseStatus): ReadonlyArray<string> =>
	status.projects.slice(0, FLEET_INSIGHTS_LIMIT).map((project) => project.ref)

/**
 * Metrics and log issues follow the window alone, so they load beside the status; advisors fan out
 * over the connected organization's first projects, so they wait for it.
 */
const requestProjects = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = model.window
	if (window === null) return { model }
	const projectsKey = requestKey(context.orgId, "getSupabaseProjects", { data: window })
	const issuesKey = requestKey(context.orgId, "getSupabaseLogIssues", { data: window })
	const [projects, projectFetches] = requestSlot(model.projects, projectsKey, mode, () =>
		FetchProjects({ key: projectsKey, window }),
	)
	const [issues, issueFetches] = requestSlot(model.issues, issuesKey, mode, () =>
		FetchIssues({ key: issuesKey, window }),
	)
	const windowed = { ...model, projects, issues }
	const status = connectedStatus(model)
	if (status === null) return { model: windowed, commands: [...projectFetches, ...issueFetches] }
	const refs = insightRefs(status)
	const insightsKey = requestKey(context.orgId, "getSupabaseFleetInsights", { refs })
	const [insights, insightFetches] = requestSlot(model.insights, insightsKey, mode, () =>
		FetchInsights({ key: insightsKey, refs }),
	)
	return {
		model: { ...windowed, insights },
		commands: [...projectFetches, ...issueFetches, ...insightFetches],
	}
}

/** One panel's retry: its slot re-read on its own. */
const retryIssues = (model: Model, context: PageContext): Return => {
	const window = model.window
	if (window === null) return { model }
	const key = requestKey(context.orgId, "getSupabaseLogIssues", { data: window })
	const [issues, commands] = requestSlot(model.issues, key, "Refresh", () => FetchIssues({ key, window }))
	return { model: { ...model, issues }, commands }
}

const retryInsights = (model: Model, context: PageContext): Return => {
	const status = connectedStatus(model)
	if (status === null) return { model }
	const refs = insightRefs(status)
	const key = requestKey(context.orgId, "getSupabaseFleetInsights", { refs })
	const [insights, commands] = requestSlot(model.insights, key, "Refresh", () =>
		FetchInsights({ key, refs }),
	)
	return { model: { ...model, insights }, commands }
}

const requestStatus = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const key = statusKey(context)
	const [status, commands] = requestSlot(model.status, key, mode, () =>
		LoadStatus({ key, refresh: mode === "Refresh" }),
	)
	return { model: { ...model, status }, commands }
}

const searchHref = (search: Search) => hrefOf(AppRoute.InfraSupabase({ search }))

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: searchHref(search), isReplace: false }),
})

const withWindow = (model: Model, window: TimeWindow, nowMs: number): Model => ({ ...model, window, nowMs })

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		status: Keyed.idle(),
		projects: Keyed.idle(),
		issues: Keyed.idle(),
		insights: Keyed.idle(),
		timePicker: TimeRangePicker.init("supabase-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	const status = requestStatus(model, context, "Load")
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
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const next = { ...model, search: route.search }
	return routeWindowStep(model.search, route.search, {
		resolve: (): Return => ({
			model: next,
			commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))],
		}),
		requestAll: (): Return => ({ model: next }),
	})
}

export const contextChanged = (model: Model): Return => ({ model })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestProjects(withWindow(model, window, nowMs), context, mode),
		CompletedLoadStatus: ({ key, result }) =>
			requestProjects({ ...model, status: Keyed.accept(model.status, key, result) }, context, "Load"),
		CompletedFetchProjects: ({ key, result }) => ({
			model: { ...model, projects: Keyed.accept(model.projects, key, result) },
		}),
		CompletedFetchIssues: ({ key, result }) => ({
			model: { ...model, issues: Keyed.accept(model.issues, key, result) },
		}),
		CompletedFetchInsights: ({ key, insights }) => ({
			model: { ...model, insights: Keyed.accept(model.insights, key, Result.succeed(insights)) },
		}),
		TickedWaitingRefresh: () => {
			const projects = requestProjects(model, context, "Refresh")
			const status = requestStatus(projects.model, context, "Refresh")
			return {
				model: status.model,
				commands: [...(projects.commands ?? []), ...(status.commands ?? [])],
			}
		},
		ClickedRetryProjects: () => requestProjects(model, context, "Refresh"),
		ClickedRetryStatus: () => requestStatus(model, context, "Refresh"),
		ClickedRetryIssues: () => retryIssues(model, context),
		ClickedRetryInsights: () => retryInsights(model, context),
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
				(preset) => searchHref(withPreset(model.search, preset)),
			)
			return {
				model: { ...model, timePicker: step.timePicker },
				commands: step.commands,
				outMessage: step.outMessage,
			}
		},
	})
