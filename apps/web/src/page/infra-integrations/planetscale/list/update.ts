import { metricsNeverCollected } from "../../../../components/integrations/planetscale-setup-steps"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { nextSort, type Sort } from "../../../kit/table-sort"
import { CompleteReloadSpin, FetchDatabases, FetchStats, LoadStatus, ResolveWindow } from "./command"
import { Message, type Model, type RequestMode, type SortKey } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]

export const DEFAULT_PRESET = "12h"

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const hrefOfSearch = (search: Search) => hrefOf(AppRoute.InfraPlanetscale({ search }))

const isConnected = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.status.data), {
		onNone: () => false,
		onSome: (status) => status.connected,
	})

/** Whether nothing was ever scraped: the table hides its metric columns and sorts by name. */
export const neverCollected = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.status.data), { onNone: () => false, onSome: metricsNeverCollected })

/** `useTableSort`'s state: the clicked sort, else the initial one for the metrics state. */
export const sortOf = (model: Model): Sort<SortKey> =>
	model.sort ?? { key: neverCollected(model) ? "name" : "connectionsAvg", dir: "desc" }

type Step = Readonly<{ model: Model; commands: Return["commands"] }>

const merge = (steps: ReadonlyArray<(model: Model) => Step>, model: Model): Return =>
	steps.reduce<Return>(
		(acc, step) => {
			const next = step(acc.model)
			return { model: next.model, commands: [...(acc.commands ?? []), ...(next.commands ?? [])] }
		},
		{ model, commands: [] },
	)

const databasesStep =
	(context: PageContext, mode: Keyed.RequestMode) =>
	(model: Model): Step => {
		const key = requestKey(context.orgId, "planetscaleIntegration.databases", {})
		return Option.match(Keyed.request(model.databases, key, mode), {
			onNone: () => ({ model, commands: [] }),
			onSome: (databases) => ({ model: { ...model, databases }, commands: [FetchDatabases({ key })] }),
		})
	}

const statsStep =
	(context: PageContext, mode: Keyed.RequestMode) =>
	(model: Model): Step => {
		const window = model.window
		if (window === null) return { model, commands: [] }
		const key = requestKey(context.orgId, "getServiceMapPlanetScale", { data: window })
		return Option.match(Keyed.request(model.stats, key, mode), {
			onNone: () => ({ model, commands: [] }),
			onSome: (stats) => ({ model: { ...model, stats }, commands: [FetchStats({ key, window })] }),
		})
	}

/** `PlanetScaleData` mounts once the status says connected: inventory, then the window's stats. */
const requestData = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return =>
	isConnected(model) ? merge([databasesStep(context, "Load"), statsStep(context, mode)], model) : { model }

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const key = requestKey(context.orgId, "planetscaleIntegration.status", {})
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		status: { key, data: AsyncData.Loading() },
		databases: Keyed.idle(),
		stats: Keyed.idle(),
		sort: null,
		timePicker: TimeRangePicker.init("planetscale-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	return { model, commands: [resolveCommand(model, context, "Load"), LoadStatus({ key, refresh: false })] }
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (hrefOfSearch(model.search) === hrefOfSearch(route.search)) return { model }
	const next = { ...model, search: route.search }
	const resolve = (): Return => ({ model: next, commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))] })
	return routeWindowStep(model.search, route.search, {
		resolve,
		requestAll: (mode) => (next.window === null ? resolve() : requestData(next, context, mode)),
	})
}

export const contextChanged = (model: Model): Return => ({ model })

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOfSearch(search), isReplace: false }),
})

const withWindow = (model: Model, window: TimeWindow, nowMs: number): Model => ({ ...model, window, nowMs })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestData(withWindow(model, window, nowMs), context, mode),
		CompletedLoadStatus: ({ key, result }) =>
			requestData({ ...model, status: Keyed.accept(model.status, key, result) }, context, "Load"),
		CompletedFetchDatabases: ({ key, result }) => ({
			model: { ...model, databases: Keyed.accept(model.databases, key, result) },
		}),
		CompletedFetchStats: ({ key, result }) => ({
			model: { ...model, stats: Keyed.accept(model.stats, key, result) },
		}),
		ClickedRetryStats: () => merge([statsStep(context, "Refresh")], model),
		ClickedSort: ({ key }) => ({
			model: { ...model, sort: nextSort(sortOf(model), key, { stringKeys: ["name"] }) },
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
