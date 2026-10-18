import { normalizeLayout } from "@maple/grid-engine"
import { GRID_ROW_HEIGHT, projectLayout, tierForWidth } from "@maple/web/components/dashboard-builder/canvas/grid-breakpoints"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AREA_CHART_TOKENS } from "../../charts/area-chart"
import * as Chart from "../../charts/chart"
import { ResolveThemeColors } from "../../charts/theme-colors"
import { button } from "../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyTitle } from "../../ui/empty"
import { icon } from "../../ui/icon"
import { skeleton } from "../../ui/skeleton"
import type { PageViewInputs } from "../contract"
import { toPanelType } from "../dashboards/kit/chart-registry"
import type { WidgetDataState } from "../dashboards/kit/data-state"
import { widgetTile } from "../dashboards/kit/tiles"
import { refreshControls } from "../kit/refresh-controls"
import { MeasureGrid, WatchTile } from "./command"
import { Message } from "./message"
import type { Model, ShareError, SharedDashboard, ShareWidget, WidgetState } from "./model"
import { refreshSecondsOf } from "./update"

// `SharePage` (apps/web/src/routes/share/$token.tsx): its own chrome outside the app shell.
// TODO(sections): grouped widgets (sections and tabs) draw only on the root canvas.
// TODO(embed): `?embed` drops the header but the frame gate (`isFramed`) and the transparent
// backdrop are not ported; `?theme` is not applied.

type H = HtmlBuilder<Message>

const shell = (h: H, children: ReadonlyArray<Html>, title?: string): Html =>
	h.div([h.Class("flex min-h-screen flex-col bg-background")], [
		h.header([h.Class("flex items-center justify-between gap-4 border-b px-6 py-3")], [
			title === undefined
				? h.span([], [])
				: h.h1([h.Class("min-w-0 truncate font-medium text-sm"), h.Title(title)], [title]),
			h.a(
				[
					h.Href("https://maple.dev"),
					h.Target("_blank"),
					h.Rel("noopener noreferrer"),
					h.Class(
						"flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground text-xs transition-colors hover:text-foreground",
					),
				],
				[
					h.span([h.Class("hidden sm:inline")], ["Shared via"]),
					icon(h, "MapleMark", { size: 14, className: "shrink-0", attributes: [h.AriaHidden(true)] }),
					h.span([h.Class("font-medium")], ["Maple"]),
				],
			),
		]),
		h.main([h.Class("flex-1 p-6")], children),
	])

const embedShell = (h: H, children: ReadonlyArray<Html>, scope: SharedDashboard["scope"]): Html =>
	h.div([h.Class(`${scope === "dashboard" ? "min-h-screen" : "h-screen"} w-full p-2`)], children)

const centeredCard = (h: H, title: string, body: string, children: ReadonlyArray<Html> = []): Html =>
	empty(
		h,
		[
			emptyHeader(h, [emptyTitle(h, [title]), emptyDescription(h, [body])]),
			...(children.length > 0 ? [emptyContent(h, children)] : []),
		],
		"min-h-[60vh]",
	)

const errorCard = (h: H, error: ShareError): Html => {
	switch (error._tag) {
		case "SignInRequired":
			return centeredCard(h, "Sign in to view this dashboard", "This dashboard is shared with its organization only.", [
				button(h, { attributes: [h.OnClick(Message.ClickedSignIn())] }, ["Sign in"]),
			])
		case "WrongOrg":
			return centeredCard(
				h,
				"You don't have access to this dashboard",
				"It's shared with a different organization. Switch organizations and try again.",
			)
		case "RateLimited":
			return centeredCard(h, "Too many requests", "This shared dashboard is busy right now. Try again in a moment.")
		case "Unavailable":
			return centeredCard(h, "This link isn't available", error.message)
		case "NotFound":
			return centeredCard(h, "This link isn't available", "The link may have been revoked, or it never existed.")
	}
}

const shareSkeleton = (h: H): Html =>
	h.div(
		[h.Class("grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3")],
		[0, 1, 2, 3].map(() => skeleton(h, "h-64 rounded-md border")),
	)

const dataStateOf = (state: WidgetState | undefined): WidgetDataState => {
	if (state === undefined || state._tag === "Loading") return { _tag: "Loading" }
	if (state._tag === "Ready") return { _tag: "Ready", data: state.data }
	return { _tag: "Error", title: null, message: state.message, kind: state.kind }
}

/** `SharedWidgetRenderer`: the board's tile from the page's batched state, no actions. */
const sharedTile = (h: H, model: Model, widget: ShareWidget, timeZone: string): Html => {
	const chartId = widget.display.chartId
	const panelType = toPanelType(widget.visualization, typeof chartId === "string" ? chartId : undefined)
	return h.div(
		[h.Class("h-full w-full"), h.OnMount(WatchTile({ widgetId: widget.id, isBar: panelType === "bar" }))],
		[
			widgetTile(
				h,
				{
					h,
					state: dataStateOf(model.states[widget.id]),
					isEdit: false,
					menu: null,
					isMenuOpen: false,
					hasGrip: false,
					configure: null,
					chart: model.charts[widget.id] ?? Chart.init(),
					themeColors: model.themeColors,
					chartRuntime: model.chartRuntime,
					nowMs: model.nowMs,
					timeZone,
					tableSort: model.tableSorts[widget.id] ?? { key: null, dir: "desc" },
					onChart: (message) => Message.GotChartMessage({ widgetId: widget.id, message }),
					onSort: (field, isText) => Message.ClickedSortColumn({ widgetId: widget.id, field, isText }),
				},
				widget,
			),
		],
	)
}

/** `ReadOnlyDashboardView` over the root canvas: the stored layouts at the measured width's tier. */
const board = (h: H, model: Model, share: SharedDashboard, timeZone: string): Html => {
	const widgets = share.dashboard.widgets.filter((widget) => widget.sectionId === undefined)
	const grid =
		model.gridWidth <= 0
			? null
			: (() => {
					const tier = tierForWidth(model.gridWidth)
					return { tier, layout: normalizeLayout(projectLayout(widgets, tier), tier.cols, tier.canonical ? "vertical" : "none") }
				})()
	const byId = new Map((grid?.layout ?? []).map((item) => [item.i, item]))
	return h.div([h.Class("flex h-full min-h-0 w-full flex-col")], [
		h.div([h.Class("min-h-0 flex-1 overflow-y-auto")], [
			h.div([h.Class("group/canvas is-layout-locked"), h.OnMount(MeasureGrid())], [
				...(grid === null || widgets.length === 0
					? []
					: [
							h.div(
								[
									h.DataAttribute("dashboard-grid", ""),
									h.Style({
										display: "grid",
										position: "relative",
										"grid-template-columns": `repeat(${grid.tier.cols}, minmax(0, 1fr))`,
										"grid-auto-rows": `${GRID_ROW_HEIGHT}px`,
										"column-gap": `${grid.tier.margin[0]}px`,
										"row-gap": `${grid.tier.margin[1]}px`,
										"padding-block": `${grid.tier.margin[1]}px`,
									}),
								],
								widgets.flatMap((widget) => {
									const item = byId.get(widget.id)
									return item === undefined
										? []
										: [
												h.div(
													[
														h.Key(widget.id),
														h.DataAttribute("grid-item", widget.id),
														h.DataAttribute("grid-box", `${item.x},${item.y},${item.w},${item.h}`),
														h.Class("group/cell"),
														h.Style({
															position: "relative",
															"min-width": "0px",
															"grid-column": `${item.x + 1} / span ${item.w}`,
															"grid-row": `${item.y + 1} / span ${item.h}`,
														}),
													],
													[h.div([h.Class("h-full w-full")], [sharedTile(h, model, widget, timeZone)])],
												),
											]
								}),
							),
						]),
			]),
		]),
	])
}

/** `SingleWidgetShare`: one chart filling the page, no grid. */
const singleWidget = (h: H, model: Model, share: SharedDashboard, isEmbed: boolean, timeZone: string): Html =>
	h.div(
		[h.Class("h-full w-full")],
		share.dashboard.widgets.map((widget) =>
			h.div(
				[h.Key(widget.id), h.Class(isEmbed ? "h-[calc(100vh-1rem)] w-full" : "h-[calc(100vh-9rem)] w-full")],
				[sharedTile(h, model, widget, timeZone)],
			),
		),
	)

/** `ShareBody`. */
const shareBody = (h: H, model: Model, share: SharedDashboard, isEmbed: boolean, timeZone: string): Html => {
	const window = model.window
	if (window === null)
		return centeredCard(
			h,
			"This dashboard's time range couldn't be resolved",
			"Open the link with an explicit window (?from=…&to=…) instead.",
		)
	if (share.scope === "widget") return singleWidget(h, model, share, isEmbed, timeZone)
	if (share.dashboard.widgets.length === 0)
		return centeredCard(h, "This dashboard has no charts yet", "Ask whoever shared it to add widgets, then reload.")
	return h.div([h.Class("flex flex-col gap-3")], [
		...(isEmbed
			? []
			: [
					h.div([h.Class("flex items-center justify-between gap-2")], [
						h.div([h.Class("text-muted-foreground text-xs"), h.DataAttribute("testid", "share-time-range")], [window.label]),
						refreshControls(h, {
							seconds: refreshSecondsOf(model),
							savedDefault: share.dashboard.refreshIntervalSeconds,
							// The share's controls are never pending: it passes no `isReloading`.
							isReloading: false,
							onReload: Message.ClickedReload(),
							menu: model.refreshMenu,
							toMenuMessage: (message) => Message.GotRefreshMenuMessage({ message }),
						}),
					]),
				]),
		board(h, model, share, timeZone),
	])
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const isEmbed = model.search.embed === true
	const timeZone = inputs.context.timeZone
	const resolve = model.resolve
	const wrap = (children: ReadonlyArray<Html>, title?: string) =>
		isEmbed
			? embedShell(h, children, resolve._tag === "Ready" ? resolve.share.scope : "widget")
			: shell(h, children, title)
	const page =
		resolve._tag === "Loading"
			? wrap([shareSkeleton(h)])
			: resolve._tag === "Failed"
				? wrap([errorCard(h, resolve.error)])
				: wrap([shareBody(h, model, resolve.share, isEmbed, timeZone)], resolve.share.dashboard.name)
	return h.div([h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: AREA_CHART_TOKENS }))], [page])
})
