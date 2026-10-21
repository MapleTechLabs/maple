import { toEpochMs } from "@maple/ui/lib/time-format"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import type { AgentSessionToolsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as ToggleGroup from "../../../ui/toggle-group"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { SignalPresenceData } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	chartBucketSeconds,
	DEFAULT_TOOL_PRESET,
	selectedPercentile,
	toolSelection,
	type ToolPercentile,
	type TotalsResult,
} from "../tools-kit/model"
import { ALL, facetValue, initFacetSelect } from "../tools-kit/toolbar"
import { nextSort } from "../tools-kit/table"
import {
	CompleteReloadSpin,
	DebounceSearch,
	FetchBreakdowns,
	FetchFacets,
	FetchSeries,
	FetchTotals,
	LoadSignalPresence,
	ResolveWindow,
} from "./command"
import { type FacetKey, Message, type RequestMode } from "./message"
import type { Breakdowns, Model } from "./model"
import type { LoadFailure } from "../../../data/load-failure"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
export type Search = typeof AgentSessionToolsSearch.Type

const PERCENTILES: ReadonlyArray<ToolPercentile> = ["p50", "p90", "p95"]

const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): readonly [Keyed.Keyed<A, E>, Commands] =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => [slot, []] as const,
		onSome: (next) => [next, [fetch(key)]] as const,
	})

export const bucketSecondsOf = (window: TimeWindow): number =>
	chartBucketSeconds(toEpochMs(window.startTime), toEpochMs(window.endTime))

/**
 * The tab counts read the bare window, which with no filter set is the page's own read: like two
 * atoms on one key, a slot asking for a key the other slot holds takes its answer (or its flight).
 */
const sharedSlot = <A, E>(
	slot: Keyed.Keyed<A, E>,
	other: Keyed.Keyed<A, E>,
	key: string,
): Keyed.Keyed<A, E> => (slot.key !== key && other.key === key ? other : slot)

const requestAll = (model: Model, context: PageContext, mode: RequestMode): Return => {
	const { window } = model
	if (window === null) return { model }
	const org = context.orgId
	const selection = toolSelection(model.search, window)
	const bucketSeconds = bucketSecondsOf(window)
	const [series, seriesCommands] = keyed(
		model.series,
		requestKey(org, "getAiToolSeries", { data: { ...selection, bucketSeconds } }),
		mode,
		(key) => FetchSeries({ key, selection, bucketSeconds, isScope: false }),
	)
	const [scopeSeries, scopeCommands] = keyed(
		model.scopeSeries,
		requestKey(org, "getAiToolSeries", { data: { ...selection, bucketSeconds, split: "none" } }),
		mode,
		(key) => FetchSeries({ key, selection, bucketSeconds, isScope: true }),
	)
	const totalsKey = requestKey(org, "getAiToolTotals", { data: selection })
	const [totals, totalsCommands] = keyed(
		sharedSlot(model.totals, model.tabTotals, totalsKey),
		totalsKey,
		mode,
		(key) => FetchTotals({ key, selection, isTab: false }),
	)
	const breakdownsKey = requestKey(org, "getAiToolBreakdowns", { data: selection })
	const [breakdowns, breakdownCommands] = keyed(
		sharedSlot(model.breakdowns, model.tabBreakdowns, breakdownsKey),
		breakdownsKey,
		mode,
		(key) => FetchBreakdowns({ key, selection, isTab: false }),
	)
	const [facets, facetCommands] = keyed(
		model.facets,
		requestKey(org, "getAiSessionsFacets", { data: window }),
		"Load",
		(key) => FetchFacets({ key, window }),
	)
	const bare = toolSelection({}, window)
	const tabTotalsKey = requestKey(org, "getAiToolTotals", { data: bare })
	const [tabTotals, tabTotalsCommands] = keyed(
		sharedSlot(model.tabTotals, totals, tabTotalsKey),
		tabTotalsKey,
		"Load",
		(key) => FetchTotals({ key, selection: bare, isTab: true }),
	)
	const tabBreakdownsKey = requestKey(org, "getAiToolBreakdowns", { data: bare })
	const [tabBreakdowns, tabBreakdownCommands] = keyed(
		sharedSlot(model.tabBreakdowns, breakdowns, tabBreakdownsKey),
		tabBreakdownsKey,
		"Load",
		(key) => FetchBreakdowns({ key, selection: bare, isTab: true }),
	)
	return {
		model: { ...model, series, scopeSeries, totals, breakdowns, facets, tabTotals, tabBreakdowns },
		commands: [
			...seriesCommands,
			...scopeCommands,
			...totalsCommands,
			...breakdownCommands,
			...facetCommands,
			...tabTotalsCommands,
			...tabBreakdownCommands,
		],
	}
}

/** An answer lands in every slot that asked for its key (the page's read and the tab counts'). */
const acceptTotals = (
	model: Model,
	key: string,
	result: Parameters<typeof Keyed.accept<TotalsResult, LoadFailure>>[2],
) => ({
	totals: Keyed.accept(model.totals, key, result),
	tabTotals: Keyed.accept(model.tabTotals, key, result),
})

const acceptBreakdowns = (
	model: Model,
	key: string,
	result: Parameters<typeof Keyed.accept<Breakdowns, LoadFailure>>[2],
) => ({
	breakdowns: Keyed.accept(model.breakdowns, key, result),
	tabBreakdowns: Keyed.accept(model.tabBreakdowns, key, result),
})

const resolveCommand = (search: Search, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: search.startTime,
		endTime: search.endTime,
		preset: search.timePreset ?? DEFAULT_TOOL_PRESET,
		timeZone: context.timeZone,
	})

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.AgentSessionTools({ search })),
		isReplace: false,
	}),
})

/** The controls that mirror the URL: the facet selects, the percentile toggle, the search box. */
const synced = (model: Model, search: Search): Model => ({
	...model,
	search,
	serviceSelect: { ...model.serviceSelect, value: search.service ?? ALL },
	modelSelect: { ...model.modelSelect, value: search.model ?? ALL },
	envSelect: { ...model.envSelect, value: search.env ?? ALL },
	percentileToggle: { ...model.percentileToggle, values: [selectedPercentile(search)] },
})

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const { search } = route
	const model: Model = {
		search,
		window: null,
		nowMs: 0,
		series: Keyed.idle(),
		scopeSeries: Keyed.idle(),
		totals: Keyed.idle(),
		breakdowns: Keyed.idle(),
		facets: Keyed.idle(),
		tabTotals: Keyed.idle(),
		tabBreakdowns: Keyed.idle(),
		serviceSelect: initFacetSelect("agent-tools-service", search.service),
		modelSelect: initFacetSelect("agent-tools-model", search.model),
		envSelect: initFacetSelect("agent-tools-env", search.env),
		percentileToggle: ToggleGroup.init({ label: "Percentile", values: [selectedPercentile(search)] }),
		timePicker: TimeRangePicker.init("agent-tools-time-range"),
		tableSort: { key: "calls", dir: "desc" },
		searchInput: search.q ?? "",
		searchVersion: 0,
		lastSentQuery: search.q ?? "",
		chart: Chart.init(),
		presence: SignalPresenceData.Loading(),
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			LoadSignalPresence({ orgId: context.orgId }),
			resolveCommand(search, context, "Load"),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.AgentSessionTools({ search }))

const isSameTime = (a: Search, b: Search): boolean =>
	a.startTime === b.startTime && a.endTime === b.endTime && a.timePreset === b.timePreset

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const query = route.search.q ?? ""
	const isOutsideQuery = query !== (model.search.q ?? "") && query !== model.lastSentQuery
	const next: Model = {
		...synced(model, route.search),
		searchInput: isOutsideQuery ? query : model.searchInput,
		lastSentQuery: isOutsideQuery ? query : model.lastSentQuery,
	}
	// `useEffectiveTimeRange` re-resolves only on a time change; every other change reads its new keys.
	return isSameTime(model.search, route.search)
		? requestAll(next, context, "Load")
		: { model: next, commands: [resolveCommand(route.search, context, model.refreshVersion === 0 ? "Load" : "Refresh")] }
}

export const contextChanged = (model: Model, context: PageContext): Return => ({
	model,
	commands: [resolveCommand(model.search, context, model.refreshVersion === 0 ? "Load" : "Refresh")],
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, window, nowMs }, context, mode),
		CompletedFetchSeries: ({ key, result }) => ({
			model: { ...model, series: Keyed.accept(model.series, key, result) },
		}),
		CompletedFetchScopeSeries: ({ key, result }) => ({
			model: { ...model, scopeSeries: Keyed.accept(model.scopeSeries, key, result) },
		}),
		CompletedFetchTotals: ({ key, result }) => ({
			model: { ...model, ...acceptTotals(model, key, result) },
		}),
		CompletedFetchBreakdowns: ({ key, result }) => ({
			model: { ...model, ...acceptBreakdowns(model, key, result) },
		}),
		CompletedFetchFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		CompletedFetchTabTotals: ({ key, result }) => ({
			model: { ...model, ...acceptTotals(model, key, result) },
		}),
		CompletedFetchTabBreakdowns: ({ key, result }) => ({
			model: { ...model, ...acceptBreakdowns(model, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [
					resolveCommand(model.search, context, "Refresh"),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedResetTimeRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_TOOL_PRESET,
			}),
		ChangedSearchInput: ({ value }) => {
			const searchVersion = model.searchVersion + 1
			return {
				model: { ...model, searchInput: value, searchVersion },
				commands: [DebounceSearch({ version: searchVersion })],
			}
		},
		ElapsedSearchDebounce: ({ version }) => {
			if (version !== model.searchVersion) return { model }
			const trimmed = model.searchInput.trim()
			const q = trimmed === "" ? undefined : trimmed
			return navigate({ ...model, lastSentQuery: q ?? "" }, { ...model.search, q })
		},
		ToggledFailingOnly: () =>
			navigate(model, { ...model.search, failing: model.search.failing === true ? undefined : true }),
		ClickedMetric: ({ metric }) =>
			navigate(model, { ...model.search, metric: metric === "calls" ? undefined : metric }),
		RemovedScopeChip: ({ kind }) => navigate(model, { ...model.search, [kind]: undefined }),
		ClickedClearScope: () => navigate(model, { ...model.search, tool: undefined, model: undefined }),
		ClickedTableSort: ({ key }) => ({
			model: { ...model, tableSort: nextSort(model.tableSort, key, ["key"]) },
		}),
		GotFacetSelectMessage: ({ facet, message: inner }) => facetSelectStep(model, facet, inner),
		GotPercentileMessage: ({ message: inner }) => {
			const next = ToggleGroup.update(model.percentileToggle, inner)
			const commands = Command.mapMessages(next.commands ?? [], (toggle) =>
				Message.GotPercentileMessage({ message: toggle }),
			)
			// A press on the pressed item empties the group: Base UI reports no value and the page keeps its own.
			const picked = PERCENTILES.find((candidate) => candidate === next.model.values[0])
			return inner._tag === "ClickedItem" && picked !== undefined
				? {
						...navigate(
							{ ...model, percentileToggle: next.model },
							{ ...model.search, percentile: picked === "p90" ? undefined : picked },
						),
						commands,
					}
				: {
						model: {
							...model,
							percentileToggle: { ...next.model, values: model.percentileToggle.values },
						},
						commands,
					}
		},
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted: Return = {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands ?? [], (picker) =>
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
		GotSparkMessage: () => ({ model }),
		CompletedLoadSignalPresence: ({ result }) => ({
			model: { ...model, presence: AsyncData.settle(model.presence, result) },
		}),
		GotChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.chart, inner)
			return {
				model: { ...model, chart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ message: chart }),
				),
			}
		},
	})

const facetSelectStep = (model: Model, facet: FacetKey, message: Select.Message): Return => {
	const slot = facet === "service" ? "serviceSelect" : facet === "model" ? "modelSelect" : "envSelect"
	const next = Select.update(model[slot], message)
	const updated: Model = { ...model, [slot]: next.model }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotFacetSelectMessage({ facet, message: inner }),
	)
	return next.outMessage === undefined
		? { model: updated, commands }
		: {
				...navigate(updated, { ...model.search, [facet]: facetValue(next.outMessage.value) }),
				commands,
			}
}
