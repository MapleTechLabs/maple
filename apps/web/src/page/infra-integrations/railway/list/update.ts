import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import * as Tooltip from "../../../../ui/tooltip"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { nextSort } from "../../../kit/table-sort"
import { CompleteReloadSpin, FetchServices, LoadStatus, ResolveWindow } from "./command"
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

const statusKey = (context: PageContext) => requestKey(context.orgId, "integrations.railwayStatus", {})

const isConnected = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.status.data), {
		onNone: () => false,
		onSome: (status) => status.connected,
	})

/** `RailwayServices` mounts once the status says connected; its atom keys on the window. */
const requestServices = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = model.window
	if (window === null || !isConnected(model)) return { model }
	const key = requestKey(context.orgId, "getRailwayServices", { data: window })
	return Option.match(Keyed.request(model.services, key, mode), {
		onNone: () => ({ model }),
		onSome: (services) => ({ model: { ...model, services }, commands: [FetchServices({ key, window })] }),
	})
}

const requestStatus = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const key = statusKey(context)
	return Option.match(Keyed.request(model.status, key, mode), {
		onNone: () => ({ model }),
		onSome: (status) => ({
			model: { ...model, status },
			commands: [LoadStatus({ key: status.key, refresh: mode === "Refresh" })],
		}),
	})
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.InfraRailway({ search })),
		isReplace: false,
	}),
})

const withWindow = (model: Model, window: TimeWindow, nowMs: number): Model => ({ ...model, window, nowMs })

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		status: Keyed.idle(),
		services: Keyed.idle(),
		sort: { key: "memoryMax", dir: "desc" },
		rowTooltip: Tooltip.init("railway-row-tooltip"),
		timePicker: TimeRangePicker.init("railway-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	const status = requestStatus(model, context, "Load")
	return {
		model: status.model,
		commands: [resolveCommand(model, context, "Load"), ...(status.commands ?? [])],
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.InfraRailway({ search }))

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
			requestServices(withWindow(model, window, nowMs), context, mode),
		CompletedLoadStatus: ({ key, result }) =>
			requestServices({ ...model, status: Keyed.accept(model.status, key, result) }, context, "Load"),
		CompletedFetchServices: ({ key, result }) => ({
			model: { ...model, services: Keyed.accept(model.services, key, result) },
		}),
		TickedEmptyRefresh: ({ includeStatus }) => {
			const services = requestServices(model, context, "Refresh")
			if (!includeStatus) return services
			const status = requestStatus(services.model, context, "Refresh")
			return {
				model: status.model,
				commands: [...(services.commands ?? []), ...(status.commands ?? [])],
			}
		},
		ClickedRetryServices: () => requestServices(model, context, "Refresh"),
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
		GotRowTooltipMessage: ({ message: inner }) => {
			const next = Tooltip.update(model.rowTooltip, inner)
			return {
				model: { ...model, rowTooltip: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tip) =>
					Message.GotRowTooltipMessage({ message: tip }),
				),
			}
		},
	})
