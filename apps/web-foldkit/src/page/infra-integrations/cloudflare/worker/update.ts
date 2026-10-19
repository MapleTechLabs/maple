import { AsyncData, Command } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { Resources } from "../../../../platform/resources"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import {
	CompleteReloadSpin,
	FetchDetail,
	FetchPlatform,
	FetchReleases,
	FetchWorkers,
	LoadStatus,
	LoadUsage,
	ResolveWindow,
} from "./command"
import { Message, type Model, type RequestMode } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = { readonly scriptName: string; readonly search: Search }
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

export const DEFAULT_PRESET = "12h"
const WORKER_SERVICE_PREFIX = "cloudflare-worker/"

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const hrefOfSearch = (model: Model, search: Search) =>
	hrefOf(AppRoute.InfraCloudflareWorker({ scriptName: model.scriptName, search }))

/** Every read of the window, keyed like the atoms. */
const requestAll = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = model.window
	if (window === null) return { model }
	const org = context.orgId
	const input = { startTime: window.startTime, endTime: window.endTime }
	const detailInput = {
		serviceName: `${WORKER_SERVICE_PREFIX}${model.scriptName}`,
		...input,
		bucketSeconds: chartBucketSeconds(window.startTime, window.endTime),
		accountId: model.search.account,
	}
	const releasesInput = { ...input, services: [model.scriptName] }
	const commands: Array<Commands[number]> = []
	const take = <A, E>(slot: Keyed.Keyed<A, E>, key: string, fetch: () => Commands[number]) => {
		const [next, fetches] = requestSlot(slot, key, mode, fetch)
		commands.push(...fetches)
		return next
	}
	const detailKey = requestKey(org, "getCloudflareWorkerDetail", { data: detailInput })
	const workersKey = requestKey(org, "getCloudflareWorkers", { data: input })
	const platformKey = requestKey(org, "getCloudflarePlatformResources", { data: input })
	const releasesKey = requestKey(org, "getReleases", { data: releasesInput })
	return {
		model: {
			...model,
			detail: take(model.detail, detailKey, () => FetchDetail({ key: detailKey, input: detailInput })),
			workers: take(model.workers, workersKey, () => FetchWorkers({ key: workersKey, input })),
			platform: take(model.platform, platformKey, () => FetchPlatform({ key: platformKey, input })),
			releases: take(model.releases, releasesKey, () =>
				FetchReleases({ key: releasesKey, input: releasesInput }),
			),
		},
		commands,
	}
}

const statusKey = (context: PageContext) => requestKey(context.orgId, "integrations.cloudflareStatus", {})
const usageKey = (context: PageContext) => requestKey(context.orgId, "integrations.cloudflareUsage", {})

export const init = (route: Route, context: PageContext): Return => {
	const status = statusKey(context)
	const usage = usageKey(context)
	const model: Model = {
		scriptName: route.scriptName,
		search: route.search,
		window: null,
		nowMs: 0,
		status: { key: status, data: AsyncData.Loading() },
		usage: { key: usage, data: AsyncData.Loading() },
		detail: Keyed.idle(),
		workers: Keyed.idle(),
		platform: Keyed.idle(),
		releases: Keyed.idle(),
		charts: {},
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		timePicker: TimeRangePicker.init("cloudflare-worker-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			LoadStatus({ key: status, refresh: false }),
			LoadUsage({ key: usage }),
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
	const resolve = (): Return => ({ model: next, commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))] })
	return routeWindowStep(model.search, route.search, {
		resolve,
		requestAll: (mode) => (next.window === null ? resolve() : requestAll(next, context, mode)),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	requestAll(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, window, nowMs }, context, mode),
		CompletedLoadStatus: ({ key, result }) => ({
			model: { ...model, status: Keyed.accept(model.status, key, result) },
		}),
		CompletedLoadUsage: ({ key, result }) => ({
			model: { ...model, usage: Keyed.accept(model.usage, key, result) },
		}),
		CompletedFetchDetail: ({ key, result }) => ({
			model: { ...model, detail: Keyed.accept(model.detail, key, result) },
		}),
		CompletedFetchWorkers: ({ key, result }) => ({
			model: { ...model, workers: Keyed.accept(model.workers, key, result) },
		}),
		CompletedFetchPlatform: ({ key, result }) => ({
			model: { ...model, platform: Keyed.accept(model.platform, key, result) },
		}),
		CompletedFetchReleases: ({ key, result }) => ({
			model: { ...model, releases: Keyed.accept(model.releases, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		AttachedLinkedCursor: () => ({ model }),
		TickedIngestPoll: ({ nowMs }) => ({
			model: { ...model, nowMs },
			commands: [
				LoadStatus({ key: statusKey(context), refresh: true }),
				LoadUsage({ key: usageKey(context) }),
			],
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
		ClickedResetTimeRange: () => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOfSearch(model, withPreset(model.search, DEFAULT_PRESET)),
				isReplace: false,
			}),
		}),
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
