import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { nextSort } from "../../../kit/table-sort"
import { CompleteReloadSpin, FetchProjects, LoadStatus, ResolveWindow } from "./command"
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

const isConnected = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.status.data), {
		onNone: () => false,
		onSome: (status) => status.connected,
	})

/** The project metrics load once the status says connected; the key follows the window. */
const requestProjects = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = model.window
	if (window === null || !isConnected(model)) return { model }
	const key = requestKey(context.orgId, "getSupabaseProjects", { data: window })
	return Option.match(Keyed.request(model.projects, key, mode), {
		onNone: () => ({ model }),
		onSome: (projects) => ({ model: { ...model, projects }, commands: [FetchProjects({ key, window })] }),
	})
}

const requestStatus = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return =>
	Option.match(Keyed.request(model.status, statusKey(context), mode), {
		onNone: () => ({ model }),
		onSome: (status) => ({
			model: { ...model, status },
			commands: [LoadStatus({ key: status.key, refresh: mode === "Refresh" })],
		}),
	})

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
		sort: { key: "peak", dir: "desc" },
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
		ChangedSearch: ({ value }) =>
			navigate(model, { ...model.search, q: value === "" ? undefined : value }),
		ClickedClearSearch: () => navigate(model, { ...model.search, q: undefined }),
		ClickedSort: ({ key }) => ({
			model: { ...model, sort: nextSort(model.sort, key, { stringKeys: ["displayName"] }) },
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
		ClickedResetTimeRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_PRESET,
			}),
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted: Return = {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands, (picker) =>
					Message.GotTimePickerMessage({ message: picker }),
				),
			}
			return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
				? lifted
				: {
						...lifted,
						outMessage: PageOutMessage.RequestedNavigation({
							url: searchHref({
								...model.search,
								...TimeRangePicker.searchPatchOf(next.outMessage),
							}),
							isReplace: false,
						}),
					}
		},
	})
