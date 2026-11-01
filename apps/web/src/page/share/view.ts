import { containerKeyFor, containerKeyOf, ROOT_CONTAINER_KEY } from "@maple/domain/http"
import { normalizeLayout } from "@maple/grid-engine"
import { ALL_VALUE, type VariableValues } from "@maple/query-engine"
import { resolveSectionView } from "../../lib/dashboards/section-view-state"
import {
	GRID_ROW_HEIGHT,
	projectLayout,
	tierForWidth,
} from "../../components/dashboard-builder/canvas/grid-breakpoints"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { WIDGET_CHART_TOKENS } from "../dashboards/kit/chart-tokens"
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
import { ApplyShareAppearance, MeasureGrid, WatchTile } from "./command"
import { Message } from "./message"
import type { Model, ShareError, SharedDashboard, ShareWidget, WidgetState } from "./model"
import { refreshSecondsOf } from "./update"
import { sharedSection } from "./view-sections"

// `SharePage`: its own chrome outside the app shell.

type H = HtmlBuilder<Message>

const shell = (h: H, children: ReadonlyArray<Html>, title?: string): Html =>
	h.div(
		[h.Class("flex min-h-screen flex-col bg-background")],
		[
			h.header(
				[h.Class("flex items-center justify-between gap-4 border-b px-6 py-3")],
				[
					title === undefined
						? h.span([], [])
						: h.h1([h.Class("min-w-0 truncate font-medium text-sm"), h.Title(title)], [title]),
					h.a(
						[
							h.Href("https://maple.dev"),
							h.Target("_blank"),
							h.Rel("noopener noreferrer"),
							h.Class(
								"flex shrink-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground text-xs hover:text-foreground active:text-foreground",
							),
						],
						[
							h.span([h.Class("hidden sm:inline")], ["Shared via"]),
							icon(h, "MapleMark", {
								size: 14,
								className: "shrink-0",
								attributes: [h.AriaHidden(true)],
							}),
							h.span([h.Class("font-medium")], ["Maple"]),
						],
					),
				],
			),
			h.main([h.Class("flex-1 p-6")], children),
		],
	)

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
			return centeredCard(
				h,
				"Sign in to view this dashboard",
				"This dashboard is shared with its organization only.",
				[button(h, { attributes: [h.OnClick(Message.ClickedSignIn())] }, ["Sign in"])],
			)
		case "WrongOrg":
			return centeredCard(
				h,
				"You don't have access to this dashboard",
				"It's shared with a different organization. Switch organizations and try again.",
			)
		case "RateLimited":
			return centeredCard(
				h,
				"Too many requests",
				"This shared dashboard is busy right now. Try again in a moment.",
			)
		case "Unavailable":
			return centeredCard(h, "This link isn't available", error.message)
		case "NotFound":
			return centeredCard(
				h,
				"This link isn't available",
				"The link may have been revoked, or it never existed.",
			)
	}
}

/** `NotEmbeddableCard`: only a public single-chart link may be framed, and the API decides which. */
const notEmbeddableCard = (h: H): Html =>
	centeredCard(
		h,
		"This link can't be embedded",
		"Only a shared chart set to public can be displayed inside another site. Open the link directly instead.",
	)

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
const sharedTile = (
	h: H,
	model: Model,
	widget: ShareWidget,
	variables: VariableValues,
	timeZone: string,
): Html => {
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
					variables,
					onChart: (message) => Message.GotChartMessage({ widgetId: widget.id, message }),
					onSort: (field, isText) =>
						Message.ClickedSortColumn({ widgetId: widget.id, field, isText }),
				},
				widget,
			),
		],
	)
}

const gridOf = (
	h: H,
	model: Model,
	widgets: ReadonlyArray<ShareWidget>,
	variables: VariableValues,
	timeZone: string,
): Html | null => {
	if (model.gridWidth <= 0 || widgets.length === 0) return null
	const tier = tierForWidth(model.gridWidth)
	const layout = normalizeLayout(
		projectLayout(widgets, tier),
		tier.cols,
		tier.canonical ? "vertical" : "none",
	)
	const byId = new Map(layout.map((item) => [item.i, item]))
	return h.div(
		[
			h.DataAttribute("dashboard-grid", ""),
			h.Style({
				display: "grid",
				position: "relative",
				"grid-template-columns": `repeat(${tier.cols}, minmax(0, 1fr))`,
				"grid-auto-rows": `${GRID_ROW_HEIGHT}px`,
				"column-gap": `${tier.margin[0]}px`,
				"row-gap": `${tier.margin[1]}px`,
				"padding-block": `${tier.margin[1]}px`,
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
							[
								h.div(
									[h.Class("h-full w-full")],
									[sharedTile(h, model, widget, variables, timeZone)],
								),
							],
						),
					]
		}),
	)
}

/** `ReadOnlyDashboardView`: the root grid, then each group with its active tab's grid. */
const board = (
	h: H,
	model: Model,
	share: SharedDashboard,
	variables: VariableValues,
	timeZone: string,
): Html => {
	const { widgets, sections } = share.dashboard
	const root = widgets.filter((widget) => containerKeyOf(widget) === ROOT_CONTAINER_KEY)
	const view = resolveSectionView(sections, widgets, model.sectionView)
	const rootGrid = gridOf(h, model, root, variables, timeZone)
	return h.div(
		[h.Class("flex h-full min-h-0 w-full flex-col")],
		[
			h.div(
				[h.Class("min-h-0 flex-1 overflow-y-auto")],
				[
					h.div(
						[h.Class("group/canvas is-layout-locked"), h.OnMount(MeasureGrid())],
						[
							...(rootGrid === null ? [] : [rootGrid]),
							...(model.gridWidth <= 0
								? []
								: sections.map((section) => {
										const activeTabId =
											view.activeTabs.get(section.id) ??
											section.tabs[0]?.id ??
											section.id
										const key = containerKeyFor({
											sectionId: section.id,
											tabId: activeTabId,
										})
										const inTab = widgets.filter(
											(widget) => containerKeyOf(widget) === key,
										)
										return sharedSection(h, {
											section,
											activeTabId,
											isCollapsed: view.collapsed.has(section.id),
											grid: gridOf(h, model, inTab, variables, timeZone),
										})
									})),
						],
					),
				],
			),
		],
	)
}

/** `SingleWidgetShare`: one chart filling the page, no grid. */
const singleWidget = (
	h: H,
	model: Model,
	share: SharedDashboard,
	isEmbed: boolean,
	variables: VariableValues,
	timeZone: string,
): Html =>
	h.div(
		[h.Class("h-full w-full")],
		share.dashboard.widgets.map((widget) =>
			h.div(
				[
					h.Key(widget.id),
					h.Class(isEmbed ? "h-[calc(100vh-1rem)] w-full" : "h-[calc(100vh-9rem)] w-full"),
				],
				[sharedTile(h, model, widget, variables, timeZone)],
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
	// Titles read "All" for an All selection, never the expansion, so no option list is needed.
	const variables: VariableValues = Object.fromEntries(
		Object.entries(model.variables).map(([name, value]) => [
			name,
			{ value, isAll: value === ALL_VALUE, options: [] },
		]),
	)
	if (share.scope === "widget") return singleWidget(h, model, share, isEmbed, variables, timeZone)
	if (share.dashboard.widgets.length === 0)
		return centeredCard(
			h,
			"This dashboard has no charts yet",
			"Ask whoever shared it to add widgets, then reload.",
		)
	return h.div(
		[h.Class("flex flex-col gap-3")],
		[
			...(isEmbed
				? []
				: [
						h.div(
							[h.Class("flex items-center justify-between gap-2")],
							[
								h.div(
									[
										h.Class("text-muted-foreground text-xs"),
										h.DataAttribute("testid", "share-time-range"),
									],
									[window.label],
								),
								refreshControls(h, {
									seconds: refreshSecondsOf(model),
									savedDefault: share.dashboard.refreshIntervalSeconds,
									// The share's controls are never pending: it passes no `isReloading`.
									isReloading: false,
									onReload: Message.ClickedReload(),
									menu: model.refreshMenu,
									toMenuMessage: (message) => Message.GotRefreshMenuMessage({ message }),
								}),
							],
						),
					]),
			board(h, model, share, variables, timeZone),
		],
	)
}

/** What `SharePage`'s layout effect changes: a `?theme=` override, an embed's backdrop, or nothing. */
export const appearanceOf = (search: Model["search"]): { theme: string | null; isEmbed: boolean } | null => {
	const theme = search.theme === "light" || search.theme === "dark" ? search.theme : null
	const isEmbed = search.embed === true
	return theme === null && !isEmbed ? null : { theme, isEmbed }
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const isEmbed = model.search.embed === true
	const appearance = appearanceOf(model.search)
	const timeZone = inputs.context.timeZone
	const resolve = model.resolve
	const embedShellOrShell = (children: ReadonlyArray<Html>) =>
		isEmbed ? embedShell(h, children, "widget") : shell(h, children)
	const wrap = (children: ReadonlyArray<Html>, title?: string) =>
		isEmbed
			? embedShell(h, children, resolve._tag === "Ready" ? resolve.share.scope : "widget")
			: shell(h, children, title)
	// Checked after resolve: `embeddable` is the server's answer for this token.
	const page =
		resolve._tag === "Loading"
			? wrap([shareSkeleton(h)])
			: resolve._tag === "Failed"
				? wrap([errorCard(h, resolve.error)])
				: model.isFramed && !resolve.share.embeddable
					? embedShellOrShell([notEmbeddableCard(h)])
					: wrap(
							[shareBody(h, model, resolve.share, isEmbed, timeZone)],
							resolve.share.dashboard.name,
						)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: WIDGET_CHART_TOKENS }))],
		[
			appearance === null
				? page
				: h.div([h.Class("contents"), h.OnMount(ApplyShareAppearance(appearance))], [page]),
		],
	)
})
