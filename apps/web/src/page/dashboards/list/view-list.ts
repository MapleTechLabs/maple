import { pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { rowActionsMenuContentStyles, rowActionsMenuIconStyles } from "@maple/ui/styles/ui/row-actions-menu"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { listSectionHeader, toolbarSearch } from "../kit/list-parts"
import * as Menu from "../../../ui/menu"
import * as MenuView from "../../../ui/menu-view"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton, skeletonSlowNote } from "../../../ui/skeleton"
import { listToolbar, toolbarCount } from "../../kit/list-toolbar"
import { docsLink } from "../../kit/signal-empty-state"
import { DASHBOARD_SORT_OPTIONS, type DashboardSortOption } from "../kit/summary"
import { relativeTime } from "../../kit/relative-time"
import { collectTags, displayName, queryOf, scopeOf, sectionsOf, sortOf, tagsOf } from "./derive"
import * as TagEditor from "../kit/tag-editor"
import { Message } from "./message"
import type { ListDashboard, Model, Scope } from "./model"
import { isReadOnly, rowMenuIdOf } from "./update"
import { deleteDialog } from "./view-dialogs"
import { tagFilterView } from "./view-tag-filter"

// `DashboardList`: the dashboards as rows.

type H = HtmlBuilder<Message>

const SORT_LABELS = {
	updated: "Recently updated",
	created: "Recently created",
	"name-asc": "Name A–Z",
	"name-desc": "Name Z–A",
	widgets: "Most widgets",
} satisfies Record<DashboardSortOption, string>

const SCOPE_OPTIONS = [
	{ value: "all", label: "All" },
	{ value: "favorites", label: "Favorites" },
] as const

/** `DisabledReason` around a disabled control: a `contents` tooltip trigger. */
const disabledReason = (h: H, child: Html): Html =>
	h.div(
		[
			h.Class("contents"),
			h.DataAttribute("base-ui-tooltip-trigger", ""),
			h.DataAttribute("slot", "tooltip-trigger"),
		],
		[child],
	)

/** `TagFilterMenu`: disabled with its reason while no dashboard carries a tag. */
const tagFilter = (h: H, model: Model, allTags: ReadonlyArray<string>): Html =>
	allTags.length === 0
		? disabledReason(
				h,
				button(h, { variant: "outline", size: "sm", className: "shrink-0", isDisabled: true }, [
					"Tags",
				]),
			)
		: h.submodel({
				slotId: "dashboards-tag-filter",
				model: model.tagFilter,
				view: tagFilterView,
				viewInputs: { allTags },
				toParentMessage: (message) => Message.GotTagFilterMessage({ message }),
			})

const sortEntries = (sort: DashboardSortOption): ReadonlyArray<MenuView.MenuEntry> => [
	{
		_tag: "RadioGroup",
		label: "Sort by",
		items: DASHBOARD_SORT_OPTIONS.map((option) => ({
			value: option,
			label: SORT_LABELS[option],
			isChecked: option === sort,
		})),
	},
]

const sortMenu = (h: H, model: Model): Html => {
	const sort = sortOf(model)
	return h.submodel({
		slotId: model.sortMenu.id,
		model: model.sortMenu,
		view: MenuView.view,
		viewInputs: {
			entries: sortEntries(sort),
			align: "start",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{ variant: "outline", size: "sm", className: "shrink-0", attributes: trigger },
							[SORT_LABELS[sort]],
						),
					),
				),
		},
		toParentMessage: (message) => Message.GotSortMenuMessage({ message }),
	})
}

const toolbar = (h: H, model: Model, dashboards: ReadonlyArray<ListDashboard>, scoped: number): Html => {
	const isFiltering = queryOf(model.search).trim().length > 0 || tagsOf(model.search).length > 0
	return listToolbar(h, {
		leading: segmentedSelect<Scope, Message>(h, {
			options: SCOPE_OPTIONS,
			value: scopeOf(model.search),
			onChange: (scope) => Message.ChangedScope({ scope }),
			ariaLabel: "Filter dashboards by favorite",
			size: "sm",
			className: "shrink-0",
		}),
		trailing: [
			toolbarSearch(h, {
				id: "dashboards-search",
				draft: model.searchDraft,
				placeholder: "Search dashboards…",
				className: "w-full min-w-0 sm:w-70",
				onInput: (value) => Message.ChangedSearchDraft({ value }),
			}),
			tagFilter(h, model, collectTags(dashboards)),
			sortMenu(h, model),
			toolbarCount(h, [
				isFiltering || scopeOf(model.search) === "favorites"
					? `${scoped} of ${dashboards.length}`
					: `${dashboards.length} of ${dashboards.length}`,
			]),
		],
	})
}

/** The reason in the menu itself: a tooltip would break the menu's roving focus. */
const READ_ONLY_NOTE: ReadonlyArray<MenuView.MenuEntry> = [
	{ _tag: "Separator" },
	{
		_tag: "Label",
		label: "Dashboard store unreachable, writes are disabled",
		className: "font-normal text-3xs leading-snug",
	},
]

/** Export reads what the list holds, so it survives a write failure; the rest write, so they don't. */
const rowMenuEntries = (isReadOnly: boolean): ReadonlyArray<MenuView.MenuEntry> => [
	{
		_tag: "Group",
		entries: [
			{ _tag: "Item", value: "export", label: "Export JSON" },
			{ _tag: "Item", value: "duplicate", label: "Duplicate", isDisabled: isReadOnly },
			{ _tag: "Item", value: "tags", label: "Edit tags…", isDisabled: isReadOnly },
			{ _tag: "Separator" },
			{
				_tag: "Item",
				value: "delete",
				label: "Delete…",
				variant: "destructive",
				isDisabled: isReadOnly,
			},
			...(isReadOnly ? READ_ONLY_NOTE : []),
		],
	},
]

/** `RowActionsMenu`: the kebab trigger; only the active row holds live menu state. */
const rowMenu = (h: H, model: Model, dashboard: ListDashboard): Html => {
	const menu = model.rowMenuId === dashboard.id ? model.rowMenu : Menu.init(rowMenuIdOf(dashboard.id))
	return h.submodel({
		slotId: `row-menu-${dashboard.id}`,
		model: menu,
		view: MenuView.view,
		viewInputs: {
			entries: rowMenuEntries(isReadOnly(model)),
			align: "end",
			className: rowActionsMenuContentStyles,
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								variant: "ghost",
								size: "icon-sm",
								className: "text-muted-foreground",
								attributes: [
									h.AriaLabel(`More actions for ${displayName(dashboard.name)}`),
									...trigger,
									h.DataAttribute("slot", "row-actions-trigger"),
								],
							},
							[icon(h, "DotsVerticalIcon", { className: rowActionsMenuIconStyles })],
						),
					),
				),
		},
		toParentMessage: (message) => Message.GotRowMenuMessage({ rowId: dashboard.id, message }),
	})
}

type RowContext = Readonly<{ model: Model; nowMs: number; timeZone: string }>

/** `DashboardRow`: one link for the whole row, then the star and the kebab above it. */
const dashboardRow = (h: H, context: RowContext, dashboard: ListDashboard, isFavorite: boolean): Html => {
	const isEmpty = dashboard.widgetCount === 0
	const widgets = `${dashboard.widgetCount} ${pluralize(dashboard.widgetCount, "widget")}`
	const name = displayName(dashboard.name)
	return h.keyed("div")(
		dashboard.id,
		[
			h.Class(
				"group relative flex items-center border-b border-border last:border-b-0 hover:bg-surface-sunken active:bg-surface-sunken focus-within:bg-surface-sunken",
			),
		],
		[
			h.span(
				[
					h.AriaHidden(true),
					h.Class(cn("h-13 w-0.5 shrink-0", isFavorite ? "bg-primary" : "bg-transparent")),
				],
				[],
			),
			h.a(
				[
					h.Class(
						"flex min-w-0 grow items-center gap-3 py-2.5 pr-2 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset rounded-sm",
					),
					h.Href(
						hrefOf(
							AppRoute.Dashboard({
								dashboardId: AppRoute.Dashboard.fields.dashboardId.make(dashboard.id),
								search: {},
							}),
						),
					),
				],
				[
					h.span(
						[
							h.Class(
								"flex size-5.5 shrink-0 items-center justify-center rounded-sm border border-border bg-card",
							),
						],
						[
							icon(h, dashboard.glyph, {
								size: 12,
								className: isEmpty ? "text-muted-foreground" : "text-foreground",
							}),
						],
					),
					h.span(
						[h.Class("flex min-w-0 grow flex-col gap-0.5")],
						[
							h.span(
								[
									h.Class(
										cn(
											"truncate text-sm font-medium",
											dashboard.name.trim() !== ""
												? "text-foreground"
												: "text-muted-foreground",
										),
									),
									h.Title(name),
								],
								[name],
							),
							h.span(
								[h.Class("text-muted-foreground truncate font-mono text-2xs sm:hidden")],
								[
									[isEmpty ? "no widgets" : widgets, dashboard.readsShort]
										.filter(Boolean)
										.join(" · "),
								],
							),
							...(dashboard.description === null || dashboard.description === ""
								? []
								: [
										h.span(
											[
												h.Class(
													"text-muted-foreground hidden truncate text-2xs sm:block",
												),
											],
											[dashboard.description],
										),
									]),
						],
					),
					h.span(
						[
							h.Title(dashboard.readsFull),
							h.Class("hidden w-40 shrink-0 flex-col items-end sm:flex"),
						],
						[
							h.span(
								[
									h.Class(
										cn(
											"font-mono text-2xs",
											isEmpty ? "text-severity-warn" : "text-foreground",
										),
									),
								],
								[isEmpty ? "no widgets" : widgets],
							),
							h.span(
								[h.Class("text-muted-foreground truncate font-mono text-3xs")],
								isEmpty ? [] : [dashboard.readsShort],
							),
						],
					),
					relativeTime(h, {
						variant: "orDate",
						tooltip: "title",
						mono: true,
						value: dashboard.updatedAt,
						nowMs: context.nowMs,
						timeZone: context.timeZone,
						className: "text-muted-foreground w-24 shrink-0 text-right text-2xs",
					}),
				],
			),
			h.div(
				[h.Class("flex shrink-0 items-center gap-0.5 pr-2 pl-1")],
				[
					iconButton(
						h,
						{
							size: "icon-xs",
							label: isFavorite ? `Unstar ${name}` : `Star ${name}`,
							className: isFavorite ? "text-primary" : "text-foreground-faint",
							attributes: [
								h.AriaPressed(String(isFavorite)),
								h.OnClick(Message.ToggledFavorite({ id: dashboard.id })),
							],
						},
						[icon(h, isFavorite ? "StarFilledIcon" : "StarIcon")],
					),
					rowMenu(h, context.model, dashboard),
				],
			),
		],
	)
}

/** `CreateRow`: pinned below the list so a filter can never make it read as a result. */
const createRow = (h: H, isReadOnly: boolean): Html =>
	h.button(
		[
			h.Type("button"),
			h.OnClick(Message.ClickedCreate()),
			...(isReadOnly ? [h.Disabled(true)] : []),
			h.Class(
				"mt-4 flex w-full shrink-0 items-center gap-3 rounded-md border border-dashed border-input bg-card py-3 pr-4 pl-3 text-left hover:bg-surface-sunken active:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50",
			),
		],
		[
			h.span(
				[h.Class("flex size-5.5 shrink-0 items-center justify-center")],
				[icon(h, "PlusIcon", { size: 14, className: "text-primary" })],
			),
			h.span(
				[h.Class("flex min-w-0 grow flex-wrap items-baseline gap-x-2.5 gap-y-0.5")],
				[
					h.span([h.Class("text-sm font-medium text-foreground")], ["New dashboard"]),
					h.span(
						[h.Class("text-muted-foreground text-2xs")],
						["Start blank, or pick a template already wired to metrics you send."],
					),
				],
			),
			icon(h, "ArrowRightIcon", { size: 14, className: "text-muted-foreground shrink-0" }),
		],
	)

/** `FirstRunEmpty`: templates lead, a blank canvas second. */
const firstRunEmpty = (h: H, isReadOnly: boolean): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "GridIcon", { size: 18 })]),
				emptyTitle(h, ["No dashboards yet"]),
				emptyDescription(h, [
					"Templates check what your services already send, so you can start from one that will render data immediately. Or build from an empty canvas.",
				]),
			]),
			h.div(
				[h.Class("flex flex-wrap items-center justify-center gap-2")],
				[
					linkButton(
						h,
						{ size: "sm", href: hrefOf(AppRoute.DashboardsTemplates({ search: {} })) },
						["Browse templates"],
					),
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							isDisabled: isReadOnly,
							attributes: [h.OnClick(Message.ClickedCreate())],
						},
						["Create blank dashboard"],
					),
					docsLink(h, "dashboards"),
				],
			),
		],
		"py-16",
	)

/** `FilteredEmpty` for a search or tag filter that hid every dashboard. */
const nothingMatched = (h: H, model: Model): Html => {
	const query = queryOf(model.search).trim()
	const isSearching = query.length > 0
	return empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "MagnifierIcon", { size: 16 })]),
				emptyTitle(h, [
					isSearching
						? `No dashboard matches “${query}”`
						: "No dashboard carries every selected tag",
				]),
				emptyDescription(h, [
					isSearching
						? "Search covers name, description and tags. A template might mention it."
						: "Tags combine with AND. Drop one to widen the list.",
				]),
			]),
			emptyContent(h, [
				h.div(
					[h.Class("flex items-center gap-2")],
					[
						...(isSearching
							? [
									button(
										h,
										{
											variant: "outline",
											size: "sm",
											attributes: [h.OnClick(Message.ClickedClearSearch())],
										},
										["Clear search"],
									),
								]
							: []),
						...(tagsOf(model.search).length > 0
							? [
									button(
										h,
										{
											variant: "outline",
											size: "sm",
											attributes: [h.OnClick(Message.ClickedShowAllTags())],
										},
										["Show all"],
									),
								]
							: []),
					],
				),
			]),
		],
		"py-14",
	)
}

const nothingStarred = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "StarIcon", { size: 16 })]),
				emptyTitle(h, ["Nothing starred on this device"]),
				emptyDescription(h, [
					"Favorites are stored in this browser, not shared with your org. Star a dashboard to pin it to the top of the list.",
				]),
			]),
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					attributes: [h.OnClick(Message.ChangedScope({ scope: "all" }))],
				},
				["Show all dashboards"],
			),
		],
		"py-14",
	)

export const listBody = (
	h: H,
	model: Model,
	dashboards: ReadonlyArray<ListDashboard>,
	nowMs: number,
	timeZone: string,
): Html => {
	const sections = sectionsOf(model, dashboards)
	const isFiltering = queryOf(model.search).trim().length > 0 || tagsOf(model.search).length > 0
	const isNothingAtAll = dashboards.length === 0
	const isWriteDisabled = isReadOnly(model)
	const context: RowContext = { model, nowMs, timeZone }
	const body: ReadonlyArray<Html> = isNothingAtAll
		? [firstRunEmpty(h, isWriteDisabled)]
		: sections.matched === 0
			? [nothingMatched(h, model)]
			: sections.scoped === 0
				? [nothingStarred(h)]
				: [
						...(sections.favorited.length === 0
							? []
							: [
									listSectionHeader(h, {
										title: "Favorites",
										count: sections.favorited.length,
										note: "on this device only",
									}),
									...sections.favorited.map((dashboard) =>
										dashboardRow(h, context, dashboard, true),
									),
								]),
						...(sections.others.length === 0
							? []
							: [
									listSectionHeader(h, {
										title: "All dashboards",
										count: sections.others.length,
										className: cn(sections.favorited.length > 0 && "mt-6 pt-2"),
									}),
									...sections.others.map((dashboard) =>
										dashboardRow(h, context, dashboard, false),
									),
								]),
						createRow(h, isWriteDisabled),
					]
	return h.div(
		[h.Class("flex shrink-0 flex-col pb-6")],
		[
			toolbar(h, model, dashboards, sections.scoped),
			...(isFiltering && !isNothingAtAll
				? [
						h.div(
							[h.Class("flex items-center gap-2 border-y border-border py-2 text-2xs")],
							[
								h.span([h.Class("font-mono text-foreground")], [String(sections.matched)]),
								h.span(
									[h.Class("text-muted-foreground")],
									["of ", String(dashboards.length), " match name, description or tag"],
								),
							],
						),
					]
				: []),
			...body,
			h.submodel({
				slotId: "dashboard-tag-editor",
				model: model.tagEditor,
				view: TagEditor.view,
				viewInputs: { allTags: collectTags(dashboards) },
				toParentMessage: (message) => Message.GotTagEditorMessage({ message }),
			}),
			deleteDialog(h, model),
		],
	)
}

const GHOST_ROWS = [
	{ name: "w-44", description: "w-80", reads: "w-24" },
	{ name: "w-32", description: "w-64", reads: "w-16" },
	{ name: "w-52", description: "w-96", reads: "w-28" },
	{ name: "w-36", description: "w-72", reads: "w-20" },
	{ name: "w-40", description: "w-56", reads: "w-24" },
	{ name: "w-28", description: "w-88", reads: "w-16" },
] as const

/** `DashboardListSkeleton`. */
export const listSkeleton = (h: H): Html =>
	h.div(
		[h.Role("status"), h.AriaLabel("Loading dashboards")],
		[
			h.span([h.Class("sr-only")], ["Loading dashboards"]),
			skeletonSlowNote(h, "pb-3"),
			h.div(
				[h.AriaHidden(true)],
				[
					h.div(
						[h.Class("flex flex-wrap items-center gap-2 pb-3")],
						[
							skeleton(h, "h-8 grow sm:max-w-70"),
							skeleton(h, "h-8 w-32 shrink-0"),
							skeleton(h, "h-8 w-16 shrink-0"),
							skeleton(h, "h-8 w-36 shrink-0"),
						],
					),
					h.div([h.Class("flex items-center gap-2 pb-2")], [skeleton(h, "h-2.5 w-24")]),
					...GHOST_ROWS.map((row, index) =>
						h.div(
							[
								h.Class(
									"flex h-13 items-center border-b border-border last:border-b-0 animate-tile-in motion-reduce:animate-none",
								),
								h.Style({ animationDelay: `${index * 40}ms` }),
							],
							[
								h.span([h.Class("w-0.5 shrink-0")], []),
								skeleton(h, "ml-3 size-5.5 shrink-0 rounded-sm"),
								h.div(
									[h.Class("flex min-w-0 grow flex-col gap-1.5 px-3")],
									[
										skeleton(h, `h-3 ${row.name}`),
										skeleton(h, `h-2.5 ${row.description} opacity-60`),
									],
								),
								h.div(
									[h.Class("hidden w-40 shrink-0 flex-col items-end gap-1.5 sm:flex")],
									[skeleton(h, "h-2.5 w-16"), skeleton(h, `h-2.5 ${row.reads} opacity-60`)],
								),
								h.div(
									[h.Class("flex w-24 shrink-0 justify-end")],
									[skeleton(h, "h-2.5 w-12 opacity-60")],
								),
								h.div(
									[h.Class("flex shrink-0 items-center gap-1.5 pr-2 pl-3")],
									[
										skeleton(h, "size-3.5 shrink-0 rounded-sm opacity-50"),
										skeleton(h, "size-3.5 shrink-0 rounded-sm opacity-50"),
									],
								),
							],
						),
					),
				],
			),
		],
	)
