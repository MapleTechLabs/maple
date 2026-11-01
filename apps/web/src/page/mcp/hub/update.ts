import { MCP_CLIENT_KINDS } from "@maple/domain/mcp-clients"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { Option } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import type { McpServersSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as ToggleGroup from "../../../ui/toggle-group"
import { chartBucketSeconds } from "../../agent-sessions/tools-kit/model"
import { ALL, facetValue, initFacetSelect } from "../../agent-sessions/tools-kit/toolbar"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import {
	CompleteReloadSpin,
	DebounceSearch,
	FetchOverview,
	FetchServers,
	FetchTool,
	OpenMcpConventions,
	ResolveWindow,
} from "./command"
import { type Facet, Message, type RequestMode } from "./message"
import { DEFAULT_MCP_PRESET, type McpView, type Model } from "./model"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
export type Search = typeof McpServersSearch.Type
export type McpRoute = Extract<AppRoute, { readonly _tag: "McpServers" | "McpServer" | "McpServerTool" }>

export const viewOfRoute = (route: McpRoute): McpView =>
	route._tag === "McpServers"
		? { _tag: "Servers" }
		: route._tag === "McpServer"
			? { _tag: "Server", service: route.serviceName }
			: { _tag: "Tool", service: route.serviceName, tool: route.toolName }

export const hrefOfView = (view: McpView, search: Search): string =>
	hrefOf(
		view._tag === "Servers"
			? AppRoute.McpServers({ search })
			: view._tag === "Server"
				? AppRoute.McpServer({ serviceName: view.service, search })
				: AppRoute.McpServerTool({ serviceName: view.service, toolName: view.tool, search }),
	)

export const bucketSecondsOf = (window: TimeWindow): number =>
	chartBucketSeconds(toEpochMs(window.startTime), toEpochMs(window.endTime))

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

/** A blank box is no filter; the API takes at most 200 characters. */
const blankToUndefined = (value: string | undefined) => {
	const trimmed = value?.trim().slice(0, 200) ?? ""
	return trimmed === "" ? undefined : trimmed
}

/** The view's one read, keyed by everything it sends. */
const requestView = (model: Model, context: PageContext, mode: RequestMode): Return => {
	const { window, view, search } = model
	if (window === null) return { model }
	const base = {
		startTime: window.startTime,
		endTime: window.endTime,
		bucketSeconds: bucketSecondsOf(window),
	}
	const selection = { client: search.client, kind: search.kind }
	switch (view._tag) {
		case "Servers": {
			const [servers, commands] = keyed(
				model.servers,
				requestKey(context.orgId, "getMcpServers", base),
				mode,
				(key) => FetchServers({ key, ...base }),
			)
			return { model: { ...model, servers }, commands }
		}
		case "Server": {
			const data = {
				...base,
				...selection,
				service: view.service,
				search: blankToUndefined(search.q),
				failingOnly: search.failing === true,
			}
			const [overview, commands] = keyed(
				model.overview,
				requestKey(context.orgId, "getMcpOverview", data),
				mode,
				(key) => FetchOverview({ key, ...data }),
			)
			return { model: { ...model, overview }, commands }
		}
		case "Tool": {
			const data = {
				...base,
				...selection,
				service: view.service,
				tool: view.tool,
				failingOnly: search.failing === true,
			}
			const [tool, commands] = keyed(
				model.tool,
				requestKey(context.orgId, "getMcpTool", data),
				mode,
				(key) => FetchTool({ key, ...data }),
			)
			return { model: { ...model, tool }, commands }
		}
	}
}

/** The quiet window's way out: a week, or a month once the page already shows a week or more. */
const DAY_MS = 86_400_000
const WIDER_PRESETS = [
	["1w", 7 * DAY_MS],
	["1mo", 30 * DAY_MS],
	["3mo", 90 * DAY_MS],
] as const

/** The quiet window's way out: the first preset longer than the window shown, none past three months. */
export const widerPreset = (window: TimeWindow | null): string | undefined => {
	const length = window === null ? 0 : toEpochMs(window.endTime) - toEpochMs(window.startTime)
	return WIDER_PRESETS.find(([, ms]) => ms > length * 1.01)?.[0]
}

const resolveCommand = (search: Search, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: search.startTime,
		endTime: search.endTime,
		preset: search.timePreset ?? DEFAULT_MCP_PRESET,
		timeZone: context.timeZone,
	})

const navigateTo = (model: Model, view: McpView, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOfView(view, search), isReplace: false }),
})

const navigate = (model: Model, search: Search): Return => navigateTo(model, model.view, search)

/** The controls that mirror the URL. */
const synced = (model: Model, search: Search): Model => ({
	...model,
	search,
	clientSelect: { ...model.clientSelect, value: search.client ?? ALL },
	kindSelect: { ...model.kindSelect, value: search.kind ?? ALL },
	percentileToggle: { ...model.percentileToggle, values: [search.percentile ?? "p90"] },
	clientToggle: { ...model.clientToggle, values: [search.identity ?? "ua"] },
	callsToggle: { ...model.callsToggle, values: [search.calls ?? "slowest"] },
})

export const init = (route: McpRoute, context: PageContext): Return => {
	const { search } = route
	const model: Model = {
		view: viewOfRoute(route),
		search,
		window: null,
		nowMs: 0,
		servers: Keyed.idle(),
		overview: Keyed.idle(),
		tool: Keyed.idle(),
		percentileToggle: ToggleGroup.init({ label: "Percentile", values: [search.percentile ?? "p90"] }),
		clientToggle: ToggleGroup.init({ label: "Client identity", values: [search.identity ?? "ua"] }),
		callsToggle: ToggleGroup.init({ label: "Calls", values: [search.calls ?? "slowest"] }),
		clientSelect: initFacetSelect("mcp-client-select", search.client),
		kindSelect: initFacetSelect("mcp-kind-select", search.kind),
		searchInput: search.q ?? "",
		searchVersion: 0,
		timePicker: TimeRangePicker.init("mcp-time-range-picker"),
		charts: {},
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			resolveCommand(search, context, "Load"),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

const isSameTime = (a: Search, b: Search): boolean =>
	a.startTime === b.startTime && a.endTime === b.endTime && a.timePreset === b.timePreset

export const routeChanged = (model: Model, route: McpRoute, context: PageContext): Return => {
	const view = viewOfRoute(route)
	if (hrefOfView(model.view, model.search) === hrefOfView(view, route.search)) return { model }
	const next: Model = {
		...synced({ ...model, view }, route.search),
		searchInput:
			(route.search.q ?? "") === (model.search.q ?? "") ? model.searchInput : (route.search.q ?? ""),
	}
	return isSameTime(model.search, route.search)
		? requestView(next, context, "Load")
		: {
				model: next,
				commands: [
					resolveCommand(route.search, context, model.refreshVersion === 0 ? "Load" : "Refresh"),
				],
			}
}

export const contextChanged = (model: Model, context: PageContext): Return => ({
	model,
	commands: [resolveCommand(model.search, context, model.refreshVersion === 0 ? "Load" : "Refresh")],
})

/** A toggle group keeps one value pressed: a press on the pressed item leaves the URL as it was. */
const toggleStep = (
	model: Model,
	current: ToggleGroup.Model,
	message: ToggleGroup.Message,
	wrap: (message: ToggleGroup.Message) => Message,
	write: (model: Model, next: ToggleGroup.Model) => Model,
	toSearch: (value: string) => Search | undefined,
): Return => {
	const next = ToggleGroup.update(current, message)
	const commands = Command.mapMessages(next.commands ?? [], wrap)
	const picked = next.model.values[0]
	const search = message._tag === "ClickedItem" && picked !== undefined ? toSearch(picked) : undefined
	const kept = write(model, picked === undefined ? { ...next.model, values: current.values } : next.model)
	return search === undefined ? { model: kept, commands } : { ...navigate(kept, search), commands }
}

const selectStep = (model: Model, facet: Facet, message: Select.Message): Return => {
	const slot = facet === "client" ? "clientSelect" : "kindSelect"
	const next = Select.update(model[slot], message)
	const updated: Model = { ...model, [slot]: next.model }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotSelectMessage({ facet, message: inner }),
	)
	if (next.outMessage === undefined) return { model: updated, commands }
	const value = facetValue(next.outMessage.value)
	const search: Search =
		facet === "client"
			? { ...model.search, client: value }
			: { ...model.search, kind: MCP_CLIENT_KINDS.find((kind) => kind === value) }
	return { ...navigate(updated, search), commands }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestView({ ...model, window, nowMs }, context, mode),
		CompletedFetchServers: ({ key, result }) => ({
			model: { ...model, servers: Keyed.accept(model.servers, key, result) },
		}),
		CompletedFetchOverview: ({ key, result }) => ({
			model: { ...model, overview: Keyed.accept(model.overview, key, result) },
		}),
		CompletedFetchTool: ({ key, result }) => ({
			model: { ...model, tool: Keyed.accept(model.tool, key, result) },
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
				timePreset: DEFAULT_MCP_PRESET,
			}),
		ClickedWiden: () => {
			const preset = widerPreset(model.window)
			return preset === undefined
				? { model }
				: navigate(model, {
						...model.search,
						startTime: undefined,
						endTime: undefined,
						timePreset: preset,
					})
		},
		ClickedOpenServer: ({ service }) =>
			navigateTo(
				model,
				{ _tag: "Server", service },
				{
					startTime: model.search.startTime,
					endTime: model.search.endTime,
					timePreset: model.search.timePreset,
				},
			),
		ClickedOpenTool: ({ tool }) =>
			model.view._tag === "Servers"
				? { model }
				: navigateTo(
						model,
						{ _tag: "Tool", service: model.view.service, tool },
						{
							...model.search,
							q: undefined,
							metric: undefined,
							identity: undefined,
						},
					),
		ClickedInstrument: () => ({ model, commands: [OpenMcpConventions({})] }),
		ClickedOpenTrace: ({ traceId }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Trace({ traceId, search: {} })),
				isReplace: false,
			}),
		}),
		ClickedMetric: ({ metric }) =>
			navigate(model, { ...model.search, metric: metric === "calls" ? undefined : metric }),
		ChangedSearchInput: ({ value }) => {
			const searchVersion = model.searchVersion + 1
			return {
				model: { ...model, searchInput: value, searchVersion },
				commands: [DebounceSearch({ version: searchVersion })],
			}
		},
		ElapsedSearchDebounce: ({ version }) =>
			version !== model.searchVersion || model.view._tag !== "Server"
				? { model }
				: navigate(model, { ...model.search, q: blankToUndefined(model.searchInput) }),
		ToggledFailingOnly: () =>
			navigate(model, { ...model.search, failing: model.search.failing === true ? undefined : true }),
		GotSelectMessage: ({ facet, message: inner }) => selectStep(model, facet, inner),
		GotPercentileMessage: ({ message: inner }) =>
			toggleStep(
				model,
				model.percentileToggle,
				inner,
				(m) => Message.GotPercentileMessage({ message: m }),
				(current, next) => ({ ...current, percentileToggle: next }),
				(value) => {
					const percentile = (["p50", "p90", "p95"] as const).find(
						(candidate) => candidate === value,
					)
					return percentile === undefined || percentile === (model.search.percentile ?? "p90")
						? undefined
						: {
								...model.search,
								percentile: percentile === "p90" ? undefined : percentile,
								metric: model.view._tag === "Server" ? "duration" : model.search.metric,
							}
				},
			),
		GotClientToggleMessage: ({ message: inner }) =>
			toggleStep(
				model,
				model.clientToggle,
				inner,
				(m) => Message.GotClientToggleMessage({ message: m }),
				(current, next) => ({ ...current, clientToggle: next }),
				(value) =>
					value === "info" || value === "ua"
						? { ...model.search, identity: value === "ua" ? undefined : value }
						: undefined,
			),
		GotCallsToggleMessage: ({ message: inner }) =>
			toggleStep(
				model,
				model.callsToggle,
				inner,
				(m) => Message.GotCallsToggleMessage({ message: m }),
				(current, next) => ({ ...current, callsToggle: next }),
				(value) =>
					value === "slowest" || value === "failed" || value === "recent"
						? { ...model.search, calls: value === "slowest" ? undefined : value }
						: undefined,
			),
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
							url: hrefOfView(model.view, {
								...model.search,
								...TimeRangePicker.searchPatchOf(next.outMessage),
							}),
							isReplace: false,
						}),
					}
		},
		GotChartMessage: ({ chartId, message: inner }) => {
			const next = Chart.update(model.charts[chartId] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: { ...model.charts, [chartId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotChartMessage({ chartId, message: m }),
				),
			}
		},
		Ignored: () => ({ model }),
	})
