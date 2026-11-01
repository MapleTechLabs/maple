import { QueryEngineTimeoutError } from "@maple/domain/http"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { Effect, Option, Record, Schema } from "effect"
import { Command, Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../charts/chart"
import { ChartRuntime, LoadChartRuntime } from "../../charts/chart-runtime"
import { ResolveThemeColors, resolveColor, ThemeColors } from "../../charts/theme-colors"
import { toLoadFailure } from "../../data/load-failure"
import { ToolPercentile } from "../../page/agent-sessions/tools-kit/model"
import {
	facetSelect,
	facetValue,
	initFacetSelect,
	toolFilterToolbar,
} from "../../page/agent-sessions/tools-kit/toolbar"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { timeControls } from "../../page/kit/time-controls"
import * as TimeRangePicker from "../../page/kit/time-range-picker"
import { underlineTabClass, underlineTabStrip } from "../../page/kit/underline-tabs"
import { listBody } from "../../page/mcp/view-list"
import type { McpServerOverview, McpToolDetail } from "../../page/mcp/data"
import {
	formatClock,
	MCP_CHART_TOKENS,
	type McpFilters,
	type McpWindow,
	scopeText,
} from "../../page/mcp/view-kit"
import { McpClientIdentity, McpMetric, serverBody } from "../../page/mcp/view-server"
import { serviceMcpTab } from "../../page/mcp/view-service-tab"
import { noServersState, quietWindow, serverError, serverLoading } from "../../page/mcp/view-states"
import { McpCallList, toolBody } from "../../page/mcp/view-tool"
import type { Resources } from "../../platform/resources"
import { button } from "../../ui/button"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { pageDescription, pageTitle } from "../../ui/page-layout"
import * as Select from "../../ui/select"
import { skeleton } from "../../ui/skeleton"
import * as ToggleGroup from "../../ui/toggle-group"
import { serviceDot } from "../../ui/values"
import { MCP_NOW, MCP_OVERVIEW, MCP_RUN_SQL, MCP_SERVERS } from "../mcp-fixture"
import { defineShellLab } from "../shell-lab"

// `/lab/mcp`: the MCP hub's pages in the real shell over `maple-ai`'s spans from Nov 1, 2026.
// The toolbar at the bottom switches page and state; `?view=` opens one directly.

const VIEWS = ["list", "server", "tool", "service", "empty", "loading", "error", "quiet"] as const
type View = (typeof VIEWS)[number]
const VIEW_LABEL = {
	list: "/mcp",
	server: "/mcp/maple-ai",
	tool: "tool: run_sql",
	service: "service MCP tab",
	empty: "empty",
	loading: "loading",
	error: "error",
	quiet: "quiet window",
} satisfies { readonly [K in View]: string }
const TIME_ZONE = "Europe/Berlin"
const PRESET = "6h"
const WINDOW: McpWindow = { startMs: MCP_NOW - 6 * 3_600_000, label: "Last 6 hours", bucketLabel: "15m" }

const Model = Schema.Struct({
	view: Schema.Literals(VIEWS),
	metric: McpMetric,
	percentileToggle: ToggleGroup.Model,
	clientToggle: ToggleGroup.Model,
	callsToggle: ToggleGroup.Model,
	clientSelect: Select.Model,
	kindSelect: Select.Model,
	client: Schema.UndefinedOr(Schema.String),
	kind: Schema.UndefinedOr(Schema.String),
	isFailingOnly: Schema.Boolean,
	searchInput: Schema.String,
	timePicker: TimeRangePicker.Model,
	charts: Schema.Record(Schema.String, Chart.Model),
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
})
type Model = typeof Model.Type

const Facet = Schema.Literals(["client", "kind"])

const Message = defineMessageUnion({
	ClickedView: { view: Schema.Literals(VIEWS) },
	ClickedMetric: { metric: McpMetric },
	GotPercentileMessage: { message: ToggleGroup.Message },
	GotClientToggleMessage: { message: ToggleGroup.Message },
	GotCallsToggleMessage: { message: ToggleGroup.Message },
	GotSelectMessage: { facet: Facet, message: Select.Message },
	ToggledFailingOnly: {},
	ChangedSearchInput: { value: Schema.String },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
	ResolvedThemeColors: { colors: ThemeColors },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	Ignored: {},
})
type Message = typeof Message.Type
type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const Flags = Schema.Struct({ view: Schema.Literals(VIEWS) })
type Flags = typeof Flags.Type
const decodeView = Schema.decodeUnknownOption(Schema.Literals(VIEWS))
const decodePercentile = Schema.decodeUnknownOption(ToolPercentile)
const decodeIdentity = Schema.decodeUnknownOption(McpClientIdentity)
const decodeCallList = Schema.decodeUnknownOption(McpCallList)

/** A toggle group's one pressed value, decoded, or the fallback. */
const pressed = <A>(
	model: ToggleGroup.Model,
	decode: (value: string | undefined) => Option.Option<A>,
	fallback: A,
): A => Option.getOrElse(decode(model.values[0]), () => fallback)

const init = (flags: Flags): Return => ({
	model: {
		view: flags.view,
		metric: "calls",
		percentileToggle: ToggleGroup.init({ label: "Percentile", values: ["p90"] }),
		clientToggle: ToggleGroup.init({ label: "Client identity", values: ["ua"] }),
		callsToggle: ToggleGroup.init({ label: "Calls", values: ["slowest"] }),
		clientSelect: initFacetSelect("mcp-client-select", undefined),
		kindSelect: initFacetSelect("mcp-kind-select", undefined),
		client: undefined,
		kind: undefined,
		isFailingOnly: false,
		searchInput: "",
		timePicker: TimeRangePicker.init("mcp-time-range-picker"),
		charts: {},
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
	},
	commands: [
		Command.mapMessage(LoadChartRuntime(), (message) =>
			message._tag === "CompletedLoadChartRuntime"
				? Message.CompletedLoadChartRuntime()
				: Message.FailedLoadChartRuntime({ reason: message.reason }),
		),
	],
})

/** A toggle group keeps one value pressed: a press on the pressed item leaves it as it was. */
const toggleStep = (
	current: ToggleGroup.Model,
	message: ToggleGroup.Message,
	wrap: (message: ToggleGroup.Message) => Message,
	write: (next: ToggleGroup.Model) => Model,
): Return => {
	const next = ToggleGroup.update(current, message)
	const kept = next.model.values.length === 0 ? { ...next.model, values: current.values } : next.model
	return { model: write(kept), commands: Command.mapMessages(next.commands ?? [], wrap) }
}

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedView: ({ view }) => ({ model: { ...model, view } }),
		ClickedMetric: ({ metric }) => ({ model: { ...model, metric } }),
		GotPercentileMessage: ({ message: inner }) =>
			toggleStep(
				model.percentileToggle,
				inner,
				(m) => Message.GotPercentileMessage({ message: m }),
				// Arrow keys and focus reach here too; only a new percentile switches the chart.
				(next) => ({
					...model,
					percentileToggle: next,
					metric: next.values[0] === model.percentileToggle.values[0] ? model.metric : "duration",
				}),
			),
		GotClientToggleMessage: ({ message: inner }) =>
			toggleStep(
				model.clientToggle,
				inner,
				(m) => Message.GotClientToggleMessage({ message: m }),
				(next) => ({
					...model,
					clientToggle: next,
				}),
			),
		GotCallsToggleMessage: ({ message: inner }) =>
			toggleStep(
				model.callsToggle,
				inner,
				(m) => Message.GotCallsToggleMessage({ message: m }),
				(next) => ({
					...model,
					callsToggle: next,
				}),
			),
		GotSelectMessage: ({ facet, message: inner }) => {
			const current = facet === "client" ? model.clientSelect : model.kindSelect
			const next = Select.update(current, inner)
			const value =
				next.outMessage === undefined
					? facet === "client"
						? model.client
						: model.kind
					: facetValue(next.outMessage.value)
			return {
				model:
					facet === "client"
						? { ...model, clientSelect: next.model, client: value }
						: { ...model, kindSelect: next.model, kind: value },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotSelectMessage({ facet, message: m }),
				),
			}
		},
		ToggledFailingOnly: () => ({ model: { ...model, isFailingOnly: !model.isFailingOnly } }),
		ChangedSearchInput: ({ value }) => ({ model: { ...model, searchInput: value } }),
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			return {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotTimePickerMessage({ message: m }),
				),
			}
		},
		GotChartMessage: ({ chartId, message: inner }) => {
			const next = Chart.update(model.charts[chartId] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: Record.set(model.charts, chartId, next.model) },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotChartMessage({ chartId, message: m }),
				),
			}
		},
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		Ignored: () => ({ model }),
	})

type H = HtmlBuilder<Message>

const timeActions = (h: H, model: Model, extra: ReadonlyArray<Html> = []): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		[
			...extra,
			timeControls(h, {
				search: { timePreset: PRESET },
				defaultPreset: PRESET,
				window: null,
				onReset: Message.Ignored(),
				onReload: Message.Ignored(),
				isReloading: false,
				trigger: (label) =>
					h.submodel({
						slotId: "mcp-time-range-picker",
						model: model.timePicker,
						view: TimeRangePicker.view,
						toParentMessage: (message: TimeRangePicker.Message) =>
							Message.GotTimePickerMessage({ message }),
						viewInputs: { label, selectedPreset: PRESET, presets: TimeRangePicker.PRESET_VALUES },
					}),
			}),
		],
	)

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

const SERVER_DESCRIPTION = `MCP ${MCP_OVERVIEW.protocolVersion} over ${MCP_OVERVIEW.transport} · ${MCP_OVERVIEW.tools.length} tools called · first MCP spans today ${formatClock(MCP_OVERVIEW.firstSpanMs, TIME_ZONE)}`
const TOOL_DESCRIPTION = `${MCP_RUN_SQL.calls} calls from ${MCP_RUN_SQL.clients} clients · first call today ${formatClock(MCP_RUN_SQL.firstCallMs, TIME_ZONE)} · last call ${formatRelativeTime(MCP_RUN_SQL.lastCallMs, MCP_NOW)}`

/** The kind facet's counts: calls per client kind. */
const KIND_OPTIONS = ["agent", "script", "unknown"].map((kind) => ({
	name: kind,
	count: MCP_OVERVIEW.clients
		.filter((client) => client.kind === kind)
		.reduce((sum, client) => sum + client.calls, 0),
}))

const filtersOf = (model: Model): McpFilters => ({
	search: model.searchInput,
	client: model.client,
	kind: model.kind,
	isFailingOnly: model.isFailingOnly,
})

/** The fixture narrowed the way the reads would be: tool name, failing only, client and kind. */
const filteredOverview = (filters: McpFilters): McpServerOverview => {
	const needle = filters.search.trim().toLowerCase()
	const clients = MCP_OVERVIEW.clients.filter(
		(client) =>
			(filters.client === undefined || client.name === filters.client) &&
			(filters.kind === undefined || client.kind === filters.kind),
	)
	const names = new Set(clients.map((client) => client.name))
	return {
		...MCP_OVERVIEW,
		tools: MCP_OVERVIEW.tools.filter(
			(row) => row.tool.toLowerCase().includes(needle) && (!filters.isFailingOnly || row.errors > 0),
		),
		clients,
		clientSeries: MCP_OVERVIEW.clientSeries.filter((point) => names.has(point.seriesKey)),
	}
}

const filteredTool = (filters: McpFilters): McpToolDetail => {
	const keep = (call: McpToolDetail["slowest"][number]) =>
		(filters.client === undefined || call.client === filters.client) &&
		(!filters.isFailingOnly || call.errorType !== null)
	return {
		...MCP_RUN_SQL,
		clientSeries: MCP_RUN_SQL.clientSeries.filter(
			(point) => filters.client === undefined || point.seriesKey === filters.client,
		),
		slowest: MCP_RUN_SQL.slowest.filter(keep),
		failed: MCP_RUN_SQL.failed.filter(keep),
		recent: MCP_RUN_SQL.recent.filter(keep),
	}
}

const toolbar = (h: H, model: Model, withSearch: boolean): Html => {
	const clientSelect = facetSelect(h, {
		label: "client",
		value: model.client,
		options: MCP_OVERVIEW.clients.map((client) => ({ name: client.name, count: client.calls })),
		model: model.clientSelect,
		toMessage: (message) => Message.GotSelectMessage({ facet: "client", message }),
	})
	const base = {
		isFailingOnly: model.isFailingOnly,
		onToggleFailingOnly: Message.ToggledFailingOnly(),
		isWaiting: false,
	}
	if (!withSearch) return toolFilterToolbar(h, { ...base, selects: [clientSelect] })
	return toolFilterToolbar(h, {
		...base,
		nameSearch: {
			value: model.searchInput,
			inputId: "mcp-tools-search",
			onInput: (value: string) => Message.ChangedSearchInput({ value }),
			onClear: Message.ChangedSearchInput({ value: "" }),
		},
		selects: [
			clientSelect,
			facetSelect(h, {
				label: "kind",
				value: model.kind,
				options: KIND_OPTIONS,
				model: model.kindSelect,
				toMessage: (message) => Message.GotSelectMessage({ facet: "kind", message }),
			}),
		],
	})
}

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

/** Sparks draw no focus or tooltip; their frame messages are dropped, as Agent Tools does. */
const sparkEnv = (theme: ThemeColors, token: string) => ({
	color: resolveColor(theme, token),
	toMessage: (_message: Chart.Message) => Message.Ignored(),
})

const chartEnv = (model: Model, theme: ThemeColors) => ({
	charts: model.charts,
	theme,
	timeZone: TIME_ZONE,
	toChart: (chartId: string, message: Chart.Message) => Message.GotChartMessage({ chartId, message }),
	spark: sparkEnv(theme, "--primary"),
})

/** Skeletons while the chart library loads; the error state if it never does. */
const chartsLoading = (h: H, model: Model): Html =>
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
		: h.div(
				[h.Class("flex flex-col gap-5 p-6")],
				[skeleton(h, "h-8 max-w-2xl"), skeleton(h, "h-56"), skeleton(h, "h-80")],
			)

const LAB_FAILURE = toLoadFailure(
	new QueryEngineTimeoutError({ message: "The query ran past its time limit." }),
)

const serverPage = (h: H, model: Model, body: Html): Html =>
	dashboardPage(
		h,
		{
			titleContent: serverTitle(h, MCP_OVERVIEW.service, SERVER_DESCRIPTION),
			actions: timeActions(h, model, [
				button(
					h,
					{
						variant: "outline",
						size: "sm",
						attributes: [h.OnClick(Message.ClickedView({ view: "service" }))],
					},
					[icon(h, "ServerIcon", { size: 14 }), "Service"],
				),
			]),
			scrollClassName: "p-0",
		},
		[body],
	)

const pageView = (model: Model, h: H): Html => {
	const theme = model.themeColors
	const isChartReady = theme !== null && model.chartRuntime._tag === "Ready"
	const openTool = () => Message.ClickedView({ view: "tool" })
	const ignore = () => Message.Ignored()
	const filters = filtersOf(model)
	switch (model.view) {
		case "list":
		case "empty":
			return dashboardPage(
				h,
				{
					title: "MCP Servers",
					description:
						"Every service that answers MCP requests: the tools agents call, the clients calling them, and why calls fail.",
					actions: timeActions(h, model),
					scrollClassName: "p-0",
				},
				[
					model.view === "empty"
						? noServersState(h, { onInstrument: Message.Ignored() })
						: theme === null || !isChartReady
							? chartsLoading(h, model)
							: listBody(h, MCP_SERVERS, {
									onOpenServer: () => Message.ClickedView({ view: "server" }),
									onInstrument: Message.Ignored(),
									nowMs: MCP_NOW,
									timeZone: TIME_ZONE,
									spark: sparkEnv(theme, "--primary"),
								}),
				],
			)
		case "server":
			return serverPage(
				h,
				model,
				theme === null || !isChartReady
					? chartsLoading(h, model)
					: serverBody(h, filteredOverview(filters), {
							env: chartEnv(model, theme),
							toolbar: toolbar(h, model, true),
							scope: scopeText("all tools", filters),
							window: WINDOW,
							metric: model.metric,
							percentile: pressed(model.percentileToggle, decodePercentile, "p90"),
							onSelectMetric: (metric: McpMetric) => Message.ClickedMetric({ metric }),
							percentileToggle: segmented(
								h,
								model.percentileToggle,
								ToolPercentile.literals.map((value) => ({ value, label: value })),
								(message) => Message.GotPercentileMessage({ message }),
								"absolute top-3 right-5 p-px",
							),
							clientIdentity: pressed(model.clientToggle, decodeIdentity, "ua"),
							clientToggle: segmented(
								h,
								model.clientToggle,
								[
									{ value: "ua", label: "user agent" },
									{ value: "info", label: "clientInfo" },
								],
								(message) => Message.GotClientToggleMessage({ message }),
							),
							onOpenTool: openTool,
							nowMs: MCP_NOW,
						}),
			)
		case "tool":
			return dashboardPage(
				h,
				{
					titleContent: h.div(
						[h.Class("flex flex-col gap-1")],
						[
							pageTitle(h, { title: MCP_RUN_SQL.tool, className: "font-mono leading-8" }, [
								MCP_RUN_SQL.tool,
							]),
							pageDescription(h, [TOOL_DESCRIPTION], "text-sm"),
						],
					),
					actions: timeActions(h, model, [
						button(h, { variant: "outline", size: "sm" }, [
							icon(h, "PulseIcon", { size: 14 }),
							"Traces",
						]),
					]),
					scrollClassName: "p-0",
				},
				[
					theme === null || !isChartReady
						? chartsLoading(h, model)
						: toolBody(h, filteredTool(filters), {
								env: chartEnv(model, theme),
								toolbar: toolbar(h, model, false),
								scope: scopeText(MCP_RUN_SQL.tool, {
									...filters,
									search: "",
									kind: undefined,
								}),
								window: WINDOW,
								percentile: pressed(model.percentileToggle, decodePercentile, "p90"),
								callList: pressed(model.callsToggle, decodeCallList, "slowest"),
								onOpenGroup: ignore,
								onOpenTrace: ignore,
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
								nowMs: MCP_NOW,
							}),
				],
			)
		case "service":
			return dashboardPage(
				h,
				{
					titleContent: pageTitle(h, { title: MCP_OVERVIEW.service }, [
						serviceDot(h, {
							serviceName: MCP_OVERVIEW.service,
							className: "relative -top-px mr-2.5 inline-block size-3 align-middle",
						}),
						MCP_OVERVIEW.service,
					]),
					actions: timeActions(h, model, [
						button(h, { variant: "outline", size: "sm" }, [
							icon(h, "BellIcon", { size: 14 }),
							"Create alert",
						]),
					]),
					tabs: underlineTabStrip(
						h,
						{ label: "Service sections", navigation: true },
						["Overview", "API", "Operations", "Dependencies", "MCP"].map((label) =>
							h.a([h.Class(underlineTabClass(label === "MCP")), h.Href("#")], [label]),
						),
					),
					scrollClassName: "p-0",
				},
				[
					theme === null || !isChartReady
						? chartsLoading(h, model)
						: serviceMcpTab(h, MCP_OVERVIEW, {
								onOpenServer: Message.ClickedView({ view: "server" }),
								onOpenTool: openTool,
								spark: sparkEnv(theme, "--chart-throughput"),
							}),
				],
			)
		case "loading":
			return serverPage(h, model, serverLoading(h))
		case "error":
			return serverPage(h, model, serverError(h, { failure: LAB_FAILURE, onRetry: Message.Ignored() }))
		case "quiet":
			return serverPage(
				h,
				model,
				quietWindow(h, {
					service: MCP_OVERVIEW.service,
					window: "last 15 minutes",
					lastCall: "42 minutes ago",
					onWiden: Message.ClickedView({ view: "server" }),
					widenLabel: "Show the last 6 hours",
				}),
			)
	}
}

const view = (model: Model, h: H): Html =>
	h.div(
		[
			h.Class("contents"),
			h.OnMount(
				Mount.mapMessage(ResolveThemeColors({ tokens: MCP_CHART_TOKENS }), (message) =>
					Message.ResolvedThemeColors({ colors: message.colors }),
				),
			),
		],
		[pageView(model, h)],
	)

const viewSwitcher = (model: Model, h: H): Html =>
	h.div(
		[
			h.Class(
				"fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-raised",
			),
		],
		VIEWS.map((view) =>
			h.button(
				[
					h.Type("button"),
					h.OnClick(Message.ClickedView({ view })),
					h.Class(
						view === model.view
							? "rounded-md bg-accent px-2 py-1 font-mono text-xs text-foreground"
							: "rounded-md px-2 py-1 font-mono text-xs text-muted-foreground hover:text-foreground active:text-foreground",
					),
				],
				[VIEW_LABEL[view]],
			),
		),
	)

export const lab = defineShellLab("MCP hub", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => ({
		view: Option.getOrElse(
			decodeView(new URLSearchParams(window.location.search).get("view")),
			(): View => "server",
		),
	})),
	init,
	update,
	view,
	before: viewSwitcher,
	currentPath: "/mcp",
	breadcrumbs: (model) =>
		model.view === "service"
			? [{ label: "Services" }, { label: MCP_OVERVIEW.service }]
			: model.view === "list" || model.view === "empty"
				? [{ label: "MCP Servers", isPageHeading: true }]
				: model.view === "tool"
					? [{ label: "MCP Servers" }, { label: MCP_OVERVIEW.service }, { label: MCP_RUN_SQL.tool }]
					: [{ label: "MCP Servers" }],
})
