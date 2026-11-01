import { QueryEngineTimeoutError } from "@maple/domain/http"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { Effect, Option } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../charts/chart"
import { ResolveThemeColors, resolveColor, ThemeColors } from "../../charts/theme-colors"
import { toLoadFailure } from "../../data/load-failure"
import { ToolPercentile } from "../../page/agent-sessions/tools-kit/model"
import { facetSelect, toolFilterToolbar } from "../../page/agent-sessions/tools-kit/toolbar"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { timeControls } from "../../page/kit/time-controls"
import * as TimeRangePicker from "../../page/kit/time-range-picker"
import { underlineTabClass, underlineTabStrip } from "../../page/kit/underline-tabs"
import { listBody } from "../../page/mcp/view-list"
import { formatClock, MCP_CHART_TOKENS, scopeText } from "../../page/mcp/view-kit"
import { McpMetric, serverBody } from "../../page/mcp/view-server"
import { serviceMcpTab } from "../../page/mcp/view-service-tab"
import { noServersState, quietWindow, serverError, serverLoading } from "../../page/mcp/view-states"
import { toolBody } from "../../page/mcp/view-tool"
import { button } from "../../ui/button"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { pageDescription, pageTitle } from "../../ui/page-layout"
import { skeleton } from "../../ui/skeleton"
import * as ToggleGroup from "../../ui/toggle-group"
import { serviceDot } from "../../ui/values"
import { filteredOverview, filteredTool, hasFilter } from "../mcp-filter"
import {
	decodeCallList,
	decodeIdentity,
	decodePercentile,
	decodeView,
	filtersOf,
	Flags,
	init,
	Message,
	Model,
	PRESET,
	pressed,
	TIME_ZONE,
	update,
	type View,
	VIEW_LABEL,
	VIEWS,
	WINDOW,
} from "../mcp-lab"
import { MCP_NOW, MCP_OVERVIEW, MCP_RUN_SQL, MCP_SERVERS } from "../mcp-fixture"
import { defineShellLab } from "../shell-lab"

// `/lab/mcp`: the MCP hub's pages in the real shell over `maple-ai`'s spans from Nov 1, 2026.
// The toolbar at the bottom switches page and state; `?view=` opens one directly.

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

const toolbar = (h: H, model: Model, withSearch: boolean): Html => {
	const clientSelect = facetSelect(h, {
		label: "client",
		value: model.client,
		options: MCP_OVERVIEW.clients.map((client) => ({ name: client.name, count: client.calls })),
		model: model.clientSelect,
		toMessage: (message) => Message.GotSelectMessage({ facet: "client", message }),
	})
	const kindSelect = facetSelect(h, {
		label: "kind",
		value: model.kind,
		options: KIND_OPTIONS,
		model: model.kindSelect,
		toMessage: (message) => Message.GotSelectMessage({ facet: "kind", message }),
	})
	const base = {
		isFailingOnly: model.isFailingOnly,
		onToggleFailingOnly: Message.ToggledFailingOnly(),
		isWaiting: false,
	}
	if (!withSearch) return toolFilterToolbar(h, { ...base, selects: [clientSelect, kindSelect] })
	return toolFilterToolbar(h, {
		...base,
		nameSearch: {
			value: model.searchInput,
			inputId: "mcp-tools-search",
			onInput: (value: string) => Message.ChangedSearchInput({ value }),
			onClear: Message.ChangedSearchInput({ value: "" }),
		},
		selects: [clientSelect, kindSelect],
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
							toolCount: MCP_OVERVIEW.tools.length,
							isFiltered: hasFilter(filters),
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
