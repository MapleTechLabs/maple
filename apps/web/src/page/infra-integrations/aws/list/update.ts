import { Option } from "effect"
import { AsyncData } from "foldkit"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import type { FleetRead } from "../data"
import {
	CompleteReloadSpin,
	FetchFleet,
	FetchSparks,
	FetchTraced,
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

const statusKey = (context: PageContext) => requestKey(context.orgId, "awsIntegration.status", {})

/** The kinds that reported, in tab order; empty before the fleet read lands. */
export const reportedKinds = (model: Model): ReadonlyArray<FleetRead["kind"]> =>
	Option.match(AsyncData.getData(model.fleet.data), {
		onNone: () => [],
		onSome: (reads) => reads.map((read) => read.kind),
	})

/** The tab in the URL when it reported, else the first that did. */
export const activeKind = (model: Model): FleetRead["kind"] | undefined => {
	const kinds = reportedKinds(model)
	return kinds.find((kind) => kind === model.search.tab) ?? kinds[0]
}

/** Sparklines follow the shown tab, so they wait for the fleet to name it. */
const requestSparks = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = model.window
	const kind = activeKind(model)
	if (window === null || kind === undefined) return { model }
	const input = {
		startTime: window.startTime,
		endTime: window.endTime,
		bucketSeconds: chartBucketSeconds(window.startTime, window.endTime),
		kinds: [kind],
	}
	const key = requestKey(context.orgId, "getAwsInfraSparklines", { data: input })
	const [sparks, commands] = requestSlot(model.sparks, key, mode, () => FetchSparks({ key, input }))
	return { model: { ...model, sparks }, commands }
}

const requestWindowed = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = model.window
	if (window === null) return { model }
	const fleetKey = requestKey(context.orgId, "getAwsInfraFleet", { data: window })
	const tracedKey = requestKey(context.orgId, "getServiceOverview", { data: window })
	const [fleet, fleetFetches] = requestSlot(model.fleet, fleetKey, mode, () =>
		FetchFleet({ key: fleetKey, window }),
	)
	const [traced, tracedFetches] = requestSlot(model.traced, tracedKey, mode, () =>
		FetchTraced({ key: tracedKey, window }),
	)
	const sparks = requestSparks({ ...model, fleet, traced }, context, mode)
	return {
		model: sparks.model,
		commands: [...fleetFetches, ...tracedFetches, ...(sparks.commands ?? [])],
	}
}

const requestStatus = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const key = statusKey(context)
	const [status, commands] = requestSlot(model.status, key, mode, () => LoadStatus({ key }))
	return { model: { ...model, status }, commands }
}

export const searchHref = (search: Search) => hrefOf(AppRoute.InfraAws({ search }))

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
		fleet: Keyed.idle(),
		sparks: Keyed.idle(),
		traced: Keyed.idle(),
		timePicker: TimeRangePicker.init("aws-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	const status = requestStatus(model, context, "Load")
	return {
		model: status.model,
		commands: [resolveCommand(model, context, "Load"), ...(status.commands ?? [])],
	}
}

/** A tab, scope or filter change re-reads only the sparklines of the tab it shows. */
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
		requestAll: (): Return => requestSparks(next, context, "Load"),
	})
}

export const contextChanged = (model: Model): Return => ({ model })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestWindowed(withWindow(model, window, nowMs), context, mode),
		CompletedLoadStatus: ({ key, result }) => ({
			model: { ...model, status: Keyed.accept(model.status, key, result) },
		}),
		CompletedFetchFleet: ({ key, result }) =>
			requestSparks({ ...model, fleet: Keyed.accept(model.fleet, key, result) }, context, "Load"),
		CompletedFetchSparks: ({ key, result }) => ({
			model: { ...model, sparks: Keyed.accept(model.sparks, key, result) },
		}),
		CompletedFetchTraced: ({ key, result }) => ({
			model: { ...model, traced: Keyed.accept(model.traced, key, result) },
		}),
		ClickedRetryFleet: () => requestWindowed(model, context, "Refresh"),
		ClickedRetryStatus: () => requestStatus(model, context, "Refresh"),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			const status = requestStatus(reloaded, context, "Refresh")
			return {
				model: status.model,
				commands: [
					resolveCommand(reloaded, context, "Refresh"),
					...(status.commands ?? []),
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
		ChangedSearch: ({ value }) =>
			navigate(model, { ...model.search, q: value === "" ? undefined : value }),
		ClickedClearSearch: () => navigate(model, { ...model.search, q: undefined }),
		ClickedRegion: ({ region }) => navigate(model, { ...model.search, region }),
		ClickedScope: ({ scope }) => navigate(model, { ...model.search, scope }),
	})
