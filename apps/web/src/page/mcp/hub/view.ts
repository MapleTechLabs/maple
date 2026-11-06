import { MCP_CLIENT_KINDS } from "@maple/domain/mcp-clients"
import { formatRelativeTime, toEpochMs } from "@maple/ui/lib/time-format"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Chart from "@maple/views/charts/chart"
import { ResolveThemeColors, resolveColor, type ThemeColors } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { linkButton } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { pageDescription, pageTitle } from "@maple/views/ui/page-layout"
import { skeleton } from "@maple/views/ui/skeleton"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { serviceDot } from "@maple/views/ui/values"
import { ToolPercentile } from "../../agent-sessions/tools-kit/model"
import { facetSelect, toolFilterToolbar } from "../../agent-sessions/tools-kit/toolbar"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { presetLabel, timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { linkTabStrip } from "../../kit/underline-tabs"
import type { McpFilters, McpWindow } from "../view-kit"
import { formatClock, MCP_CHART_TOKENS, scopeText } from "../view-kit"
import { listBody } from "../view-list"
import { serverBody } from "../view-server"
import { sessionBody, sessionCalls, sessionsBody } from "../view-sessions"
import {
	noServersState,
	noSessionsState,
	quietWindow,
	serverError,
	serverLoading,
	sessionNotFound,
	sessionsLoading,
} from "../view-states"
import { toolBody } from "../view-tool"
import { overviewOf, serverRows, sessionsScreen, toolOf } from "./data-map"
import { Message } from "./message"
import { DEFAULT_MCP_PRESET, type Model } from "./model"
import {
	bucketSecondsOf,
	hrefOfView,
	sessionHref,
	shownPreset,
	tabSearch,
	userHref,
	widerPreset,
} from "./update"
import { hstack, vstack } from "@maple/views/ui/stack"

type H = HtmlBuilder<Message>

/** A bucket width as `1d`, `6h`, `1h 45m` or `15m`: chart buckets are whole minutes, not always whole hours. */
export const bucketLabel = (seconds: number): string => {
	const days = Math.floor(seconds / 86_400)
	const hours = Math.floor((seconds % 86_400) / 3_600)
	const minutes = Math.round((seconds % 3_600) / 60)
	const parts = [days > 0 ? `${days}d` : "", hours > 0 ? `${hours}h` : "", minutes > 0 ? `${minutes}m` : ""]
	return (
		Arr.join(
			Arr.filter(parts, (part) => part !== ""),
			" ",
		) || "1m"
	)
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
	Str.trim(filters.search) !== ""

const timeActions = (h: H, model: Model, extra: ReadonlyArray<Html> = []): Html =>
	hstack(h, { gap: "2", wrap: true }, [
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
	])

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
	nameSearch?: Readonly<{ inputId: string; placeholder?: string }>,
): Html => {
	const clientSelect = facetSelect(h, {
		label: "client",
		value: model.search.client,
		options: Arr.map(clients, (client) => ({ name: client.name, count: client.calls })),
		model: model.clientSelect,
		toMessage: (message) => Message.GotSelectMessage({ facet: "client", message }),
	})
	const kindSelect = facetSelect(h, {
		label: "kind",
		value: model.search.kind,
		options: Arr.filter(
			Arr.map(MCP_CLIENT_KINDS, (kind) => ({
				name: kind,
				count: Arr.reduce(
					Arr.filter(clients, (client) => client.kind === kind),
					0,
					(sum, client) => sum + client.calls,
				),
				// A kind whose clients only connected or listed tools still filters its requests.
			})),
			(option) => Arr.some(clients, (client) => client.kind === option.name),
		),
		model: model.kindSelect,
		toMessage: (message) => Message.GotSelectMessage({ facet: "kind", message }),
	})
	const base = {
		isFailingOnly: model.search.failing === true,
		onToggleFailingOnly: Message.ToggledFailingOnly(),
		isWaiting,
		selects: [clientSelect, kindSelect],
	}
	return nameSearch !== undefined
		? toolFilterToolbar(h, {
				...base,
				nameSearch: {
					...nameSearch,
					value: model.searchInput,
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
	vstack(h, { gap: "1" }, [
		pageTitle(h, { title: name, className: "leading-8" }, [
			serviceDot(h, {
				serviceName: name,
				className: "relative -top-px mr-2.5 inline-block size-3 align-middle",
			}),
			name,
		]),
		pageDescription(h, [description], "text-sm"),
	])

const openInstrumentDocs = Message.ClickedInstrument()

const serversView = (h: H, model: Model, timeZone: string): Html =>
	dashboardPage(
		h,
		{
			title: "MCP servers",
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

/**
 * The slot's data while it answers this page. Moving to another server or tool keeps the last
 * page's answer on screen as it refreshes; that answer belongs to the page left, so it reads as loading.
 */
export const dataFor = <A, E>(
	data: AsyncData.AsyncData<A, E>,
	isFor: (value: A) => boolean,
): AsyncData.AsyncData<A, E> =>
	Option.match(AsyncData.getData(data), {
		onNone: () => data,
		onSome: (value) => (isFor(value) ? data : AsyncData.Loading()),
	})

const serverView = (h: H, model: Model, service: string, timeZone: string): Html => {
	const overview = dataFor(model.overview.data, (value) => value.service === service)
	const data = AsyncData.getOrElse(overview, () => undefined)
	const window = windowOf(model)
	const filters = filtersOf(model)
	const isNew = data !== undefined && window !== undefined && data.firstSpanMs >= window.startMs
	const description =
		data === undefined || data.firstSpanMs === 0
			? "MCP server"
			: Arr.join(
					[
						...(data.protocolVersion === "" ? [] : [`MCP ${data.protocolVersion}`]),
						`${data.toolCount} ${data.toolCount === 1 ? "tool" : "tools"} called`,
						...(isNew ? [`first MCP span ${formatClock(data.firstSpanMs, timeZone)}`] : []),
					],
					" · ",
				)
	const body = AsyncData.matchData(overview, {
		onEmpty: () => serverLoading(h),
		onFailure: (failure) => serverError(h, { failure, onRetry: Message.ClickedReload() }),
		onData: (response) => {
			if (window === undefined) return serverLoading(h)
			if (response.allClients.length === 0)
				return quietWindow(h, {
					service,
					window: windowWords(window),
					hasOtherSpans: response.methods.length > 0,
					connected: Arr.map(
						Arr.filter(response.clients, (client) => client.connects > 0),
						(client) => client.name,
					),
					widen: widenOf(model),
				})
			return chartsReady(h, model, (theme) =>
				serverBody(h, overviewOf(response, model.nowMs), {
					env: chartEnv(model, theme, timeZone),
					toolbar: toolbar(h, model, response.allClients, AsyncData.isRefreshing(overview), {
						inputId: "mcp-tools-search",
					}),
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
						Arr.map(ToolPercentile.literals, (value) => ({ value, label: value })),
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
			tabs: serverTabs(h, model, service, "Server"),
			scrollClassName: "p-0",
		},
		[body],
	)
}

/** A server's two lists: its tools (the overview) and its sessions. */
const serverTabs = (h: H, model: Model, service: string, current: "Server" | "Sessions"): Html => {
	const search = tabSearch(model.search)
	const tab = (key: "Server" | "Sessions", label: string) => ({
		key,
		label,
		href: hrefOfView({ _tag: key, service }, search),
		isCurrent: key === current,
		isRouteActive: key === current,
	})
	return linkTabStrip(h, "MCP server", [tab("Server", "Tools"), tab("Sessions", "Sessions")])
}

const widenOf = (model: Model) =>
	Option.match(Option.fromUndefinedOr(widerPreset(model.window, shownPreset(model.search))), {
		onNone: () => undefined,
		onSome: (preset) => ({
			onWiden: Message.ClickedWiden(),
			label: `Show the ${Str.toLowerCase(presetLabel(preset))}`,
		}),
	})

const windowWords = (window: McpWindow): string => Str.replace(/^Last /, "last ")(window.label)

const sessionsView = (h: H, model: Model, service: string, timeZone: string): Html => {
	const sessions = dataFor(model.sessions.data, (value) => value.service === service)
	const data = AsyncData.getOrElse(sessions, () => undefined)
	const window = windowOf(model)
	const filters = filtersOf(model)
	const description =
		data === undefined || data.totals.sessions === 0
			? "MCP sessions"
			: `${data.totals.sessions.toLocaleString()} ${data.totals.sessions === 1 ? "session" : "sessions"} · ${data.totals.calls.toLocaleString()} ${data.totals.calls === 1 ? "tool call" : "tool calls"}`
	const body = AsyncData.matchData(sessions, {
		onEmpty: () => sessionsLoading(h),
		onFailure: (failure) =>
			serverError(h, {
				failure,
				onRetry: Message.ClickedReload(),
				title: "Couldn't load MCP sessions",
			}),
		onData: (response) => {
			if (window === undefined) return sessionsLoading(h)
			const screen = sessionsScreen(response)
			if (screen === "quiet")
				return quietWindow(h, {
					service,
					window: windowWords(window),
					hasOtherSpans: response.otherRequests > 0,
					widen: widenOf(model),
				})
			if (screen === "noSessions")
				return noSessionsState(h, { service, onInstrument: openInstrumentDocs })
			return chartsReady(h, model, (theme) =>
				sessionsBody(h, response, {
					env: chartEnv(model, theme, timeZone),
					toolbar: toolbar(h, model, response.allClients, AsyncData.isRefreshing(sessions), {
						inputId: "mcp-sessions-search",
						placeholder: "Session id or user id…",
					}),
					scope: scopeText("all sessions", filters),
					isWaiting: AsyncData.isRefreshing(sessions),
					isFailingOnly: filters.isFailingOnly,
					sessionHref: (sessionId) => sessionHref(service, sessionId, model.search),
					userHref: (userId) => userHref(userId, model.search),
					nowMs: model.nowMs,
					timeZone,
				}),
			)
		},
	})
	return dashboardPage(
		h,
		{
			titleContent: serverTitle(h, service, description),
			actions: timeActions(h, model),
			tabs: serverTabs(h, model, service, "Sessions"),
			scrollClassName: "p-0",
		},
		[body],
	)
}

/** The session's tool calls, as "the first" ones when the read was cut. */
const callCountText = (calls: number, isTruncated: boolean): string =>
	`${isTruncated ? "the first " : ""}${calls.toLocaleString()} ${calls === 1 ? "tool call" : "tool calls"}`

const sessionView = (h: H, model: Model, service: string, sessionId: string, timeZone: string): Html => {
	const session = dataFor(
		model.session.data,
		(value) => value.service === service && value.sessionId === sessionId,
	)
	const data = AsyncData.getOrElse(session, () => undefined)
	const window = windowOf(model)
	const first = data?.requests[0]
	const userLabel = data?.userName ?? data?.user ?? undefined
	const isUserSession = data?.source === "user"
	// A user session's id is a key the page reads back: until its read lands, it is just "User session".
	const title =
		isUserSession && userLabel !== undefined
			? `${userLabel} on ${data.client}`
			: data === undefined && Str.startsWith("user:")(sessionId)
				? "User session"
				: sessionId
	const description =
		data === undefined || first === undefined
			? `MCP session on ${service}`
			: Arr.join(
					[
						...(isUserSession
							? ["User session, no session id: split after 30 idle minutes"]
							: [data.client, ...(userLabel === undefined ? [] : [userLabel])]),
						callCountText(sessionCalls(data.requests).length, data.isTruncated),
						`started ${formatClock(first.timeMs, timeZone)}`,
						...(data.protocolVersion === "" ? [] : [`MCP ${data.protocolVersion}`]),
					],
					" · ",
				)
	const body = AsyncData.matchData(session, {
		onEmpty: () => serverLoading(h),
		onFailure: (failure) =>
			serverError(h, {
				failure,
				onRetry: Message.ClickedReload(),
				title: "Couldn't load this MCP session",
			}),
		onData: (response) =>
			window === undefined
				? serverLoading(h)
				: response.requests.length === 0
					? sessionNotFound(h, { service, window: windowWords(window), widen: widenOf(model) })
					: sessionBody(h, response, {
							onOpenTrace: (traceId) => Message.ClickedOpenTrace({ traceId }),
							onOpenAgentSession: (id) => Message.ClickedOpenAgentSession({ sessionId: id }),
							onOpenTool: (tool) => Message.ClickedOpenTool({ tool }),
							timeZone,
						}),
	})
	return dashboardPage(
		h,
		{
			titleContent: h.div(
				[h.Class("flex min-w-0 flex-col gap-1")],
				[
					pageTitle(h, { title, className: "truncate font-mono leading-8" }, [title]),
					pageDescription(h, [description], "text-sm"),
					...(data === undefined || data.user === null
						? []
						: [
								linkButton(
									h,
									{
										variant: "link",
										size: "xs",
										className: "h-auto self-start p-0",
										href: userHref(data.user, model.search),
									},
									[
										icon(h, "UserIcon", { size: 12 }),
										`View user ${userLabel ?? data.user}`,
									],
								),
							]),
				],
			),
			actions: timeActions(h, model),
			scrollClassName: "p-0",
		},
		[body],
	)
}

const toolView = (h: H, model: Model, service: string, tool: string, timeZone: string): Html => {
	const detail = dataFor(model.tool.data, (value) => value.service === service && value.tool === tool)
	const data = AsyncData.getOrElse(detail, () => undefined)
	const window = windowOf(model)
	const filters = { ...filtersOf(model), search: "" }
	const description =
		data === undefined || data.calls === 0
			? "MCP tool"
			: `${data.calls.toLocaleString()} calls from ${data.clients} ${data.clients === 1 ? "client" : "clients"} · last call ${formatRelativeTime(data.lastCallMs, model.nowMs)}`
	const body = AsyncData.matchData(detail, {
		onEmpty: () => serverLoading(h),
		onFailure: (failure) => serverError(h, { failure, onRetry: Message.ClickedReload() }),
		onData: (response) =>
			window === undefined
				? serverLoading(h)
				: chartsReady(h, model, (theme) =>
						toolBody(h, toolOf(response), {
							env: chartEnv(model, theme, timeZone),
							toolbar: toolbar(h, model, response.allClients, AsyncData.isRefreshing(detail)),
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
			titleContent: vstack(h, { gap: "1" }, [
				pageTitle(h, { title: tool, className: "font-mono leading-8" }, [tool]),
				pageDescription(h, [description], "text-sm"),
			]),
			actions: timeActions(h, model),
			scrollClassName: "p-0",
		},
		[body],
	)
}

const viewOf = (h: H, model: Model, timeZone: string): Html => {
	const { view } = model
	switch (view._tag) {
		case "Servers":
			return serversView(h, model, timeZone)
		case "Server":
			return serverView(h, model, view.service, timeZone)
		case "Tool":
			return toolView(h, model, view.service, view.tool, timeZone)
		case "Sessions":
			return sessionsView(h, model, view.service, timeZone)
		case "Session":
			return sessionView(h, model, view.service, view.sessionId, timeZone)
	}
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const { timeZone } = inputs.context
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: MCP_CHART_TOKENS }))],
		[viewOf(h, model, timeZone)],
	)
})
