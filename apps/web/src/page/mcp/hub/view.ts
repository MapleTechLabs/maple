import { MCP_CLIENT_KINDS } from "@maple/domain/mcp-clients"
import { formatRelativeTime, toEpochMs } from "@maple/ui/lib/time-format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Chart from "../../../charts/chart"
import { ResolveThemeColors, resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import { errorState } from "../../../ui/error-state"
import { pageDescription, pageTitle } from "../../../ui/page-layout"
import { skeleton } from "../../../ui/skeleton"
import * as ToggleGroup from "../../../ui/toggle-group"
import { serviceDot } from "../../../ui/values"
import { ToolPercentile } from "../../agent-sessions/tools-kit/model"
import { facetSelect, toolFilterToolbar } from "../../agent-sessions/tools-kit/toolbar"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { presetLabel, timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import type { McpFilters, McpWindow } from "../view-kit"
import { formatClock, MCP_CHART_TOKENS, scopeText } from "../view-kit"
import { listBody } from "../view-list"
import { serverBody } from "../view-server"
import { noServersState, quietWindow, serverError, serverLoading } from "../view-states"
import { toolBody } from "../view-tool"
import { overviewOf, serverRows, toolOf } from "./data-map"
import { Message } from "./message"
import { DEFAULT_MCP_PRESET, type Model } from "./model"
import { bucketSecondsOf, widerPreset } from "./update"

type H = HtmlBuilder<Message>

/** A bucket width as `1d`, `6h`, `1h 45m` or `15m`: chart buckets are whole minutes, not always whole hours. */
export const bucketLabel = (seconds: number): string => {
	const days = Math.floor(seconds / 86_400)
	const hours = Math.floor((seconds % 86_400) / 3_600)
	const minutes = Math.round((seconds % 3_600) / 60)
	const parts = [days > 0 ? `${days}d` : "", hours > 0 ? `${hours}h` : "", minutes > 0 ? `${minutes}m` : ""]
	return parts.filter((part) => part !== "").join(" ") || "1m"
}

const windowOf = (model: Model): McpWindow | undefined =>
	model.window === null
		? undefined
		: {
				startMs: toEpochMs(model.window.startTime),
				label:
					model.search.startTime === undefined
						? presetLabel(model.search.timePreset ?? DEFAULT_MCP_PRESET)
						: "Selected range",
				bucketLabel: bucketLabel(bucketSecondsOf(model.window)),
			}

const filtersOf = (model: Model): McpFilters => ({
	search: model.searchInput,
	client: model.search.client,
	kind: model.search.kind,
	isFailingOnly: model.search.failing === true,
})

const hasFilter = (filters: McpFilters): boolean =>
	filters.client !== undefined ||
	filters.kind !== undefined ||
	filters.isFailingOnly ||
	filters.search.trim() !== ""

const timeActions = (h: H, model: Model, extra: ReadonlyArray<Html> = []): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		[
			...extra,
			timeControls(h, {
				search: model.search,
				defaultPreset: DEFAULT_MCP_PRESET,
				window: model.window,
				onReset: Message.ClickedResetTimeRange(),
				onReload: Message.ClickedReload(),
				isReloading: model.isReloading,
				trigger: (label) =>
					h.submodel({
						slotId: "mcp-time-range-picker",
						model: model.timePicker,
						view: TimeRangePicker.view,
						toParentMessage: (message: TimeRangePicker.Message) =>
							Message.GotTimePickerMessage({ message }),
						viewInputs: {
							label,
							selectedPreset:
								model.search.timePreset ??
								(model.search.startTime === undefined ? DEFAULT_MCP_PRESET : undefined),
							presets: TimeRangePicker.PRESET_VALUES,
						},
					}),
			}),
		],
	)

const segmented = (
	h: H,
	model: ToggleGroup.Model,
	items: ReadonlyArray<Readonly<{ value: string; label: string }>>,
	toMessage: (message: ToggleGroup.Message) => Message,
	className?: string,
): Html =>
	ToggleGroup.view(h, {
		model,
		toParentMessage: toMessage,
		items,
		variant: "outline",
		size: "sm",
		className: className ?? "p-px",
		itemClassName: "h-5 min-w-0 px-1.5 font-mono text-3xs uppercase sm:h-5 sm:min-w-0 sm:text-3xs",
	})

const sparkEnv = (theme: ThemeColors, token: string) => ({
	color: resolveColor(theme, token),
	toMessage: (_message: Chart.Message) => Message.Ignored(),
})

const chartEnv = (model: Model, theme: ThemeColors, timeZone: string) => ({
	charts: model.charts,
	theme,
	timeZone,
	toChart: (chartId: string, message: Chart.Message) => Message.GotChartMessage({ chartId, message }),
	spark: sparkEnv(theme, "--primary"),
})

const toolbar = (
	h: H,
	model: Model,
	clients: ReadonlyArray<Readonly<{ name: string; kind: string; calls: number }>>,
	isWaiting: boolean,
	withSearch: boolean,
): Html => {
	const clientSelect = facetSelect(h, {
		label: "client",
		value: model.search.client,
		options: clients.map((client) => ({ name: client.name, count: client.calls })),
		model: model.clientSelect,
		toMessage: (message) => Message.GotSelectMessage({ facet: "client", message }),
	})
	const kindSelect = facetSelect(h, {
		label: "kind",
		value: model.search.kind,
		options: MCP_CLIENT_KINDS.map((kind) => ({
			name: kind,
			count: clients
				.filter((client) => client.kind === kind)
				.reduce((sum, client) => sum + client.calls, 0),
		})).filter((option) => option.count > 0),
		model: model.kindSelect,
		toMessage: (message) => Message.GotSelectMessage({ facet: "kind", message }),
	})
	const base = {
		isFailingOnly: model.search.failing === true,
		onToggleFailingOnly: Message.ToggledFailingOnly(),
		isWaiting,
		selects: [clientSelect, kindSelect],
	}
	return withSearch
		? toolFilterToolbar(h, {
				...base,
				nameSearch: {
					value: model.searchInput,
					inputId: "mcp-tools-search",
					onInput: (value: string) => Message.ChangedSearchInput({ value }),
					onClear: Message.ChangedSearchInput({ value: "" }),
				},
			})
		: toolFilterToolbar(h, base)
}

const loading = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-5 p-6")],
		[skeleton(h, "h-8 max-w-2xl"), skeleton(h, "h-56"), skeleton(h, "h-80")],
	)

/** The charts are a lazy chunk; until it and the theme land, the page shows its skeleton. */
const chartsReady = (h: H, model: Model, body: (theme: ThemeColors) => Html): Html =>
	model.chartRuntime._tag === "Failed"
		? h.div(
				[h.Class("p-4")],
				[
					errorState(h, {
						failure: toLoadFailure(model.chartRuntime.reason),
						title: "Couldn't load the charts",
					}),
				],
			)
		: model.themeColors === null || model.chartRuntime._tag === "Loading"
			? loading(h)
			: body(model.themeColors)

const serverTitle = (h: H, name: string, description: string): Html =>
	h.div(
		[h.Class("flex flex-col gap-1")],
		[
			pageTitle(h, { title: name, className: "leading-8" }, [
				serviceDot(h, {
					serviceName: name,
					className: "relative -top-px mr-2.5 inline-block size-3 align-middle",
				}),
				name,
			]),
			pageDescription(h, [description], "text-sm"),
		],
	)

const openInstrumentDocs = Message.ClickedInstrument()

const serversView = (h: H, model: Model, timeZone: string): Html =>
	dashboardPage(
		h,
		{
			title: "MCP Servers",
			description:
				"Every service that answers MCP requests: the tools agents call, the clients calling them, and why calls fail.",
			actions: timeActions(h, model),
			scrollClassName: "p-0",
		},
		[
			AsyncData.matchData(model.servers.data, {
				onEmpty: () => loading(h),
				onFailure: (failure) =>
					h.div(
						[h.Class("p-4")],
						[
							errorState(h, {
								failure,
								title: "Couldn't load MCP servers",
								onRetry: Message.ClickedReload(),
							}),
						],
					),
				onData: (data) =>
					data.servers.length === 0
						? noServersState(h, { onInstrument: openInstrumentDocs })
						: chartsReady(h, model, (theme) =>
								listBody(h, serverRows(data), {
									onOpenServer: (service) => Message.ClickedOpenServer({ service }),
									onInstrument: openInstrumentDocs,
									nowMs: model.nowMs,
									timeZone,
									spark: sparkEnv(theme, "--primary"),
								}),
							),
			}),
		],
	)

const serverView = (h: H, model: Model, service: string, timeZone: string): Html => {
	const data = AsyncData.getOrElse(model.overview.data, () => undefined)
	const window = windowOf(model)
	const filters = filtersOf(model)
	const isNew = data !== undefined && window !== undefined && data.firstSpanMs >= window.startMs
	const description =
		data === undefined || data.firstSpanMs === 0
			? "MCP server"
			: [
					...(data.protocolVersion === "" ? [] : [`MCP ${data.protocolVersion}`]),
					`${data.toolCount} ${data.toolCount === 1 ? "tool" : "tools"} called`,
					...(isNew ? [`first MCP span ${formatClock(data.firstSpanMs, timeZone)}`] : []),
				].join(" · ")
	const body = AsyncData.matchData(model.overview.data, {
		onEmpty: () => serverLoading(h),
		onFailure: (failure) => serverError(h, { failure, onRetry: Message.ClickedReload() }),
		onData: (response) => {
			if (window === undefined) return serverLoading(h)
			if (response.allClients.length === 0)
				return quietWindow(h, {
					service,
					window: window.label.replace(/^Last /, "last "),
					hasOtherSpans: response.methods.length > 0,
					widen: Option.match(Option.fromUndefinedOr(widerPreset(model.window)), {
						onNone: () => undefined,
						onSome: (preset) => ({
							onWiden: Message.ClickedWiden(),
							label: `Show the ${presetLabel(preset).toLowerCase()}`,
						}),
					}),
				})
			return chartsReady(h, model, (theme) =>
				serverBody(h, overviewOf(response, model.nowMs), {
					env: chartEnv(model, theme, timeZone),
					toolbar: toolbar(
						h,
						model,
						response.allClients,
						AsyncData.isRefreshing(model.overview.data),
						true,
					),
					scope: scopeText("all tools", filters),
					window,
					toolCount: response.toolCount,
					isFiltered: hasFilter(filters),
					metric: model.search.metric ?? "calls",
					percentile: model.search.percentile ?? "p90",
					onSelectMetric: (metric) => Message.ClickedMetric({ metric }),
					percentileToggle: segmented(
						h,
						model.percentileToggle,
						ToolPercentile.literals.map((value) => ({ value, label: value })),
						(message) => Message.GotPercentileMessage({ message }),
						"absolute top-3 right-5 p-px",
					),
					clientIdentity: model.search.identity ?? "ua",
					clientToggle: segmented(
						h,
						model.clientToggle,
						[
							{ value: "ua", label: "user agent" },
							{ value: "info", label: "clientInfo" },
						],
						(message) => Message.GotClientToggleMessage({ message }),
					),
					onOpenTool: (tool) => Message.ClickedOpenTool({ tool }),
					nowMs: model.nowMs,
				}),
			)
		},
	})
	return dashboardPage(
		h,
		{
			titleContent: serverTitle(h, service, description),
			actions: timeActions(h, model),
			scrollClassName: "p-0",
		},
		[body],
	)
}

const toolView = (h: H, model: Model, tool: string, timeZone: string): Html => {
	const data = AsyncData.getOrElse(model.tool.data, () => undefined)
	const window = windowOf(model)
	const filters = { ...filtersOf(model), search: "" }
	const description =
		data === undefined || data.calls === 0
			? "MCP tool"
			: `${data.calls.toLocaleString()} calls from ${data.clients} ${data.clients === 1 ? "client" : "clients"} · last call ${formatRelativeTime(data.lastCallMs, model.nowMs)}`
	const body = AsyncData.matchData(model.tool.data, {
		onEmpty: () => serverLoading(h),
		onFailure: (failure) => serverError(h, { failure, onRetry: Message.ClickedReload() }),
		onData: (response) =>
			window === undefined
				? serverLoading(h)
				: chartsReady(h, model, (theme) =>
						toolBody(h, toolOf(response), {
							env: chartEnv(model, theme, timeZone),
							toolbar: toolbar(
								h,
								model,
								response.allClients,
								AsyncData.isRefreshing(model.tool.data),
								false,
							),
							scope: scopeText(tool, filters),
							window,
							percentile: model.search.percentile ?? "p90",
							callList: model.search.calls ?? "slowest",
							onOpenGroup: () => Message.Ignored(),
							onOpenTrace: (traceId) => Message.ClickedOpenTrace({ traceId }),
							callsToggle: segmented(
								h,
								model.callsToggle,
								[
									{ value: "slowest", label: "slowest" },
									{ value: "failed", label: "failed" },
									{ value: "recent", label: "recent" },
								],
								(message) => Message.GotCallsToggleMessage({ message }),
							),
							nowMs: model.nowMs,
						}),
					),
	})
	return dashboardPage(
		h,
		{
			titleContent: h.div(
				[h.Class("flex flex-col gap-1")],
				[
					pageTitle(h, { title: tool, className: "font-mono leading-8" }, [tool]),
					pageDescription(h, [description], "text-sm"),
				],
			),
			actions: timeActions(h, model),
			scrollClassName: "p-0",
		},
		[body],
	)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const { timeZone } = inputs.context
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: MCP_CHART_TOKENS }))],
		[
			model.view._tag === "Servers"
				? serversView(h, model, timeZone)
				: model.view._tag === "Server"
					? serverView(h, model, model.view.service, timeZone)
					: toolView(h, model, model.view.tool, timeZone),
		],
	)
})
