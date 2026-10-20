import { toggleFilterValue } from "../../../../components/infra/cloudflare/filters"
import { AsyncData, Command } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import * as Keyed from "../../../../data/keyed"
import type { LoadFailure } from "../../../../data/load-failure"
import { requestKey } from "../../../../data/request-key"
import type { Resources } from "../../../../platform/resources"
import { AppRoute, hrefOf } from "../../../../route"
import * as CopyButton from "../../../../ui/copy-button"
import * as FilterSections from "../../../../ui/filters/filter-sections"
import * as Popover from "../../../../ui/popover"
import * as Tooltip from "../../../../ui/tooltip"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import { nextSort } from "../../../kit/table-sort"
import {
	CompleteReloadSpin,
	FetchBreakdown,
	FetchDetail,
	FetchDns,
	FetchFacets,
	FetchLiveTraffic,
	FetchSecurity,
	FetchZones,
	LoadStatus,
	LoadUsage,
	ResolveWindow,
} from "./command"
import type { TopTraffic } from "../data"
import { dimensionOf, filtersOf, inputsOf, needsBreakdown } from "./derive"
import { type FilterKey, Message, type Model, type RequestMode } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = { readonly zoneName: string; readonly search: Search }
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

export const DEFAULT_PRESET = "12h"
const LIVE_ROW_LIMIT = 50

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const hrefOfSearch = (model: Model, search: Search) =>
	hrefOf(AppRoute.InfraCloudflareZone({ zoneName: model.zoneName, search }))

const navigate = (model: Model, search: Search, isReplace = false): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOfSearch(model, search), isReplace }),
})

const warehouseTimeToMs = (value: string) => new Date(`${value.replace(" ", "T")}Z`).getTime()

/** Every read the page shows right now, keyed like the atoms. */
const sync = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = model.window
	if (window === null) return { model }
	const org = context.orgId
	const inputs = inputsOf(model, window)
	const commands: Array<Commands[number]> = []
	const take = <A, E>(
		slot: Keyed.Keyed<A, E>,
		key: string,
		fetch: () => Commands[number],
		slotMode: Keyed.RequestMode = mode,
	) => {
		const [next, fetches] = requestSlot(slot, key, slotMode, fetch)
		commands.push(...fetches)
		return next
	}
	const detailKey = requestKey(org, "getCloudflareZoneDetail", { data: inputs.detail })
	const dnsKey = requestKey(org, "getCloudflareZoneDns", { data: inputs.detail })
	const securityKey = requestKey(org, "getCloudflareZoneSecurity", { data: inputs.detail })
	const facetsKey = requestKey(org, "getCloudflareZoneFacets", { data: inputs.facets })
	const zonesKey = requestKey(org, "getCloudflareZones", { data: inputs.zones })
	const base: Model = {
		...model,
		facets: take(model.facets, facetsKey, () => FetchFacets({ key: facetsKey, input: inputs.facets })),
		detail: take(model.detail, detailKey, () => FetchDetail({ key: detailKey, input: inputs.detail })),
		dns: take(model.dns, dnsKey, () => FetchDns({ key: dnsKey, input: inputs.detail })),
		security: take(model.security, securityKey, () =>
			FetchSecurity({ key: securityKey, input: inputs.detail }),
		),
		zones: take(model.zones, zonesKey, () => FetchZones({ key: zonesKey, input: inputs.zones })),
	}
	const breakdownKey = requestKey(org, "getCloudflareZoneBreakdown", { data: inputs.breakdown })
	const breakdown = needsBreakdown(base)
		? take(base.breakdown, breakdownKey, () =>
				FetchBreakdown({ key: breakdownKey, input: inputs.breakdown }),
			)
		: base.breakdown
	const liveDimension = dimensionOf(base).liveDimension
	const liveInput =
		base.liveQuery === null || liveDimension === undefined
			? null
			: {
					zoneName: base.zoneName,
					dimension: liveDimension,
					startTime: warehouseTimeToMs(window.startTime),
					endTime: warehouseTimeToMs(window.endTime),
					limit: LIVE_ROW_LIMIT,
					contains: base.liveQuery,
				}
	const liveKey =
		liveInput === null ? null : requestKey(org, "getCloudflareTopTraffic", { data: liveInput })
	// Not retained: a new lookup shows its skeleton rather than the previous lookup's rows.
	const liveTraffic =
		liveInput === null || liveKey === null
			? base.liveTraffic
			: take(
					base.liveTraffic.key === liveKey
						? base.liveTraffic
						: Keyed.idle<TopTraffic, LoadFailure>(),
					liveKey,
					() => FetchLiveTraffic({ key: liveKey, input: liveInput }),
					"Load",
				)
	return { model: { ...base, breakdown, liveTraffic }, commands }
}

const statusKey = (context: PageContext) => requestKey(context.orgId, "integrations.cloudflareStatus", {})
const usageKey = (context: PageContext) => requestKey(context.orgId, "integrations.cloudflareUsage", {})

export const init = (route: Route, context: PageContext): Return => {
	const status = statusKey(context)
	const usage = usageKey(context)
	const model: Model = {
		zoneName: route.zoneName,
		search: route.search,
		window: null,
		nowMs: 0,
		status: { key: status, data: AsyncData.Loading() },
		usage: { key: usage, data: AsyncData.Loading() },
		detail: Keyed.idle(),
		dns: Keyed.idle(),
		security: Keyed.idle(),
		facets: Keyed.idle(),
		zones: Keyed.idle(),
		dimension: "path",
		breakdown: Keyed.idle(),
		breakdownSearch: "",
		breakdownSort: { key: "requests", dir: "desc" },
		liveQuery: null,
		liveTraffic: Keyed.idle(),
		liveSort: { key: "requests", dir: "desc" },
		areChipsExpanded: false,
		filterPopover: Popover.init("cloudflare-zone-filter-popover", { align: "start" }),
		filterSections: FilterSections.init(),
		tooltip: Tooltip.init("cloudflare-zone-tooltip"),
		copyService: CopyButton.init(),
		charts: {},
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		timePicker: TimeRangePicker.init("cloudflare-zone-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			LoadStatus({ key: status, refresh: false }),
			LoadUsage({ key: usage }),
			Command.mapMessage(FilterSections.ReadRemembered(), (message) =>
				Message.GotFilterSectionsMessage({ message }),
			),
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
		resolve: (): Return => ({ model: next, commands: [resolveCommand(next, context, snapModeOf(model.refreshVersion))] }),
		requestAll: (mode) => sync(next, context, mode),
	})
}

export const contextChanged = (model: Model, context: PageContext): Return => sync(model, context, "Load")

/** `onToggleFilter`: one value in or out of a multi-select filter; `pathContains` is not toggled. */
const toggled = (model: Model, key: FilterKey, value: string): Return => {
	if (key === "pathContains") return { model }
	const next = toggleFilterValue(filtersOf(model)[key], value)
	const patch: Partial<Search> = { [key]: next === undefined ? undefined : [...next] }
	return navigate(model, { ...model.search, ...patch })
}

const lift = <Child, ChildMessage>(
	model: Model,
	next: {
		readonly model: Child
		readonly commands?: ReadonlyArray<Command.Command<ChildMessage, never, Resources>>
	},
	set: (child: Child) => Partial<Model>,
	wrap: (message: ChildMessage) => Message,
): Return => ({
	model: { ...model, ...set(next.model) },
	commands: Command.mapMessages(next.commands ?? [], wrap),
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) => sync({ ...model, window, nowMs }, context, mode),
		CompletedLoadStatus: ({ key, result }) => ({
			model: { ...model, status: Keyed.accept(model.status, key, result) },
		}),
		CompletedLoadUsage: ({ key, result }) => ({
			model: { ...model, usage: Keyed.accept(model.usage, key, result) },
		}),
		CompletedFetchDetail: ({ key, result }) =>
			sync({ ...model, detail: Keyed.accept(model.detail, key, result) }, context, "Load"),
		CompletedFetchDns: ({ key, result }) =>
			sync({ ...model, dns: Keyed.accept(model.dns, key, result) }, context, "Load"),
		CompletedFetchSecurity: ({ key, result }) =>
			sync({ ...model, security: Keyed.accept(model.security, key, result) }, context, "Load"),
		CompletedFetchFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		CompletedFetchZones: ({ key, result }) => ({
			model: { ...model, zones: Keyed.accept(model.zones, key, result) },
		}),
		CompletedFetchBreakdown: ({ key, result }) => ({
			model: { ...model, breakdown: Keyed.accept(model.breakdown, key, result) },
		}),
		CompletedFetchLiveTraffic: ({ key, result }) => ({
			model: { ...model, liveTraffic: Keyed.accept(model.liveTraffic, key, result) },
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
		ClickedTab: ({ tab }) =>
			navigate(model, { ...model.search, tab: tab === "traffic" ? undefined : tab }, true),
		ToggledFilter: ({ key, value }) => toggled(model, key, value),
		RemovedFilterChip: ({ key, value }) =>
			key === "pathContains"
				? navigate(model, { ...model.search, pathContains: undefined })
				: toggled(model, key, value),
		ClickedClearFilters: () =>
			navigate(model, {
				startTime: model.search.startTime,
				endTime: model.search.endTime,
				timePreset: model.search.timePreset,
				tab: model.search.tab,
			}),
		ClickedExpandChips: () => ({ model: { ...model, areChipsExpanded: true } }),
		ClickedDimension: ({ dimension }) =>
			sync({ ...model, dimension, breakdownSearch: "", liveQuery: null }, context, "Load"),
		ChangedBreakdownSearch: ({ value }) => ({
			model: { ...model, breakdownSearch: value, liveQuery: null },
		}),
		ClickedSearchLive: () => sync({ ...model, liveQuery: model.breakdownSearch.trim() }, context, "Load"),
		ClickedLeaveLive: () => ({ model: { ...model, liveQuery: null } }),
		ClickedBreakdownSort: ({ key }) => ({
			model: { ...model, breakdownSort: nextSort(model.breakdownSort, key, { stringKeys: ["key"] }) },
		}),
		ClickedLiveSort: ({ key }) => ({
			model: { ...model, liveSort: nextSort(model.liveSort, key, { stringKeys: ["key"] }) },
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
		GotFilterPopoverMessage: ({ message: inner }) =>
			lift(
				model,
				Popover.update(model.filterPopover, inner),
				(filterPopover) => ({ filterPopover }),
				(m) => Message.GotFilterPopoverMessage({ message: m }),
			),
		GotFilterSectionsMessage: ({ message: inner }) =>
			lift(
				model,
				FilterSections.update(model.filterSections, inner),
				(filterSections) => ({ filterSections }),
				(m) => Message.GotFilterSectionsMessage({ message: m }),
			),
		GotTooltipMessage: ({ message: inner }) =>
			lift(
				model,
				Tooltip.update(model.tooltip, inner),
				(tooltip) => ({ tooltip }),
				(m) => Message.GotTooltipMessage({ message: m }),
			),
		GotCopyServiceMessage: ({ message: inner }) =>
			lift(
				model,
				CopyButton.update(model.copyService, inner),
				(copyService) => ({ copyService }),
				(m) => Message.GotCopyServiceMessage({ message: m }),
			),
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
