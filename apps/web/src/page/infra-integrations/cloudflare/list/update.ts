import { AsyncData, Command } from "foldkit"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { Resources } from "../../../../platform/resources"
import { AppRoute, hrefOf } from "../../../../route"
import * as Menu from "../../../../ui/menu"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import { nextSort } from "../../../kit/table-sort"
import {
	CompleteReloadSpin,
	FetchPlatform,
	FetchTimeseries,
	FetchWorkers,
	FetchZones,
	LoadStatus,
	LoadUsage,
	ResolveWindow,
} from "./command"
import { statusOf } from "./derive"
import { Message, type Model, type RequestMode } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

export const DEFAULT_PRESET = "12h"
/** The account menu's "All accounts" radio. */
export const ALL_ACCOUNTS = "__all__"
export const MANAGE_ACCOUNTS = "manage-accounts"

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const hrefOfSearch = (search: Search) => hrefOf(AppRoute.InfraCloudflare({ search }))

/** Switching view drops the scope and the search; the tab link and `ClickedView` both use it. */
const withView = (search: Search, view: Search["view"]): Search => ({
	...search,
	view,
	scope: undefined,
	q: undefined,
})

/** The view tab's link: where `ClickedView` writes. */
export const viewHref = (search: Search, view: Search["view"]): string => hrefOfSearch(withView(search, view))

/** `patchSearch`: list state is written in place (a replace, not a new entry). */
const patch = (model: Model, next: Partial<Search>): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOfSearch({ ...model.search, ...next }),
		isReplace: true,
	}),
})

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOfSearch(search), isReplace: false }),
})

/** `CloudflareData` mounts once the status says connected with analytics scopes. */
const sync = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const status = statusOf(model)
	const window = model.window
	if (status === null || window === null || !status.connected || !status.analyticsCapable) return { model }
	const org = context.orgId
	const input = { startTime: window.startTime, endTime: window.endTime }
	const seriesInput = { ...input, bucketSeconds: chartBucketSeconds(window.startTime, window.endTime) }
	const commands: Array<Commands[number]> = []
	const take = <A, E>(slot: Keyed.Keyed<A, E>, key: string, fetch: () => Commands[number]) => {
		const [next, fetches] = requestSlot(slot, key, mode, fetch)
		commands.push(...fetches)
		return next
	}
	const zonesKey = requestKey(org, "getCloudflareZones", { data: input })
	const seriesKey = requestKey(org, "getCloudflareZoneTimeseries", { data: seriesInput })
	const workersKey = requestKey(org, "getCloudflareWorkers", { data: input })
	const platformKey = requestKey(org, "getCloudflarePlatformResources", { data: input })
	return {
		model: {
			...model,
			zones: take(model.zones, zonesKey, () => FetchZones({ key: zonesKey, input })),
			timeseries: take(model.timeseries, seriesKey, () =>
				FetchTimeseries({ key: seriesKey, input: seriesInput }),
			),
			workers: take(model.workers, workersKey, () => FetchWorkers({ key: workersKey, input })),
			platform: take(model.platform, platformKey, () => FetchPlatform({ key: platformKey, input })),
		},
		commands,
	}
}

const statusKey = (context: PageContext) => requestKey(context.orgId, "integrations.cloudflareStatus", {})
const usageKey = (context: PageContext) => requestKey(context.orgId, "integrations.cloudflareUsage", {})

/** The ingest poll: both reads again, the status past its shared cache. */
const refreshIngest = (model: Model, context: PageContext): Return => {
	const status = statusKey(context)
	const usage = usageKey(context)
	return {
		model,
		commands: [LoadStatus({ key: status, refresh: true }), LoadUsage({ key: usage })],
	}
}

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const status = statusKey(context)
	const usage = usageKey(context)
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		status: { key: status, data: AsyncData.Loading() },
		usage: { key: usage, data: AsyncData.Loading() },
		zones: Keyed.idle(),
		timeseries: Keyed.idle(),
		workers: Keyed.idle(),
		platform: Keyed.idle(),
		zoneSort: { key: "requests", dir: "desc" },
		queueSort: { key: "backlogMessagesMax", dir: "desc" },
		accountMenu: Menu.init("cloudflare-account-menu"),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		timePicker: TimeRangePicker.init("cloudflare-time-range"),
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

const acceptSlot = Keyed.accept

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) => sync({ ...model, window, nowMs }, context, mode),
		CompletedLoadStatus: ({ key, result }) =>
			sync({ ...model, status: acceptSlot(model.status, key, result) }, context, "Load"),
		CompletedLoadUsage: ({ key, result }) => ({
			model: { ...model, usage: acceptSlot(model.usage, key, result) },
		}),
		CompletedFetchZones: ({ key, result }) => ({
			model: { ...model, zones: acceptSlot(model.zones, key, result) },
		}),
		CompletedFetchTimeseries: ({ key, result }) => ({
			model: { ...model, timeseries: acceptSlot(model.timeseries, key, result) },
		}),
		CompletedFetchWorkers: ({ key, result }) => ({
			model: { ...model, workers: acceptSlot(model.workers, key, result) },
		}),
		CompletedFetchPlatform: ({ key, result }) => ({
			model: { ...model, platform: acceptSlot(model.platform, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		TickedIngestPoll: () => refreshIngest(model, context),
		TickedClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		ClickedView: ({ view }) => patch(model, withView(model.search, view)),
		ClickedScope: ({ scope }) => patch(model, { scope }),
		ChangedSearch: ({ value }) => patch(model, { q: value === "" ? undefined : value }),
		ClickedClearSearch: () => patch(model, { q: undefined }),
		ToggledPreviews: () => patch(model, { previews: model.search.previews === true ? undefined : true }),
		ClickedAccount: ({ accountId }) => patch(model, { account: accountId, scope: undefined }),
		ClickedZoneSort: ({ key }) => ({
			model: { ...model, zoneSort: nextSort(model.zoneSort, key, { stringKeys: ["zoneName"] }) },
		}),
		ClickedQueueSort: ({ key }) => ({
			model: { ...model, queueSort: nextSort(model.queueSort, key, { stringKeys: ["queueName"] }) },
		}),
		ClickedRetryStatus: () => ({
			model: { ...model, status: { key: statusKey(context), data: AsyncData.Loading() } },
			commands: [LoadStatus({ key: statusKey(context), refresh: true })],
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
		GotAccountMenuMessage: ({ message: inner }) => {
			const next = Menu.update(model.accountMenu, inner)
			const lifted: Return = {
				model: { ...model, accountMenu: next.model },
				commands: Command.mapMessages(next.commands ?? [], (menu) =>
					Message.GotAccountMenuMessage({ message: menu }),
				),
			}
			const out = next.outMessage
			if (out === undefined) return lifted
			if (out._tag === "SelectedRadio") {
				const account = out.value === ALL_ACCOUNTS ? undefined : out.value
				return { ...patch(lifted.model, { account, scope: undefined }), commands: lifted.commands }
			}
			if (out._tag === "SelectedItem" && out.value === MANAGE_ACCOUNTS) {
				return {
					...lifted,
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(AppRoute.SourcesNew({ search: { integration: "cloudflare" } })),
						isReplace: false,
					}),
				}
			}
			return lifted
		},
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
		GotSparklineMessage: () => ({ model }),
	})
