import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { rowActionsMenuContentStyles, rowActionsMenuIconStyles } from "@maple/ui/styles/ui/row-actions-menu"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { inputGroup, inputGroupAddon, inputGroupButton, inputGroupInput } from "../../../ui/input-group"
import * as Menu from "../../../ui/menu"
import * as MenuView from "../../../ui/menu-view"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton } from "../../../ui/skeleton"
import { docsLink } from "../../kit/signal-empty-state"
import { DASHBOARD_SORT_OPTIONS, type DashboardSortOption } from "../kit/summary"
import { relativeTimeOrDate } from "../kit/time"
import { collectTags, displayName, queryOf, scopeOf, sectionsOf, sortOf, tagsOf } from "./derive"
import * as TagEditor from "../kit/tag-editor"
import { Message } from "./message"
import type { ListDashboard, Model, Scope } from "./model"
import { rowMenuIdOf } from "./update"
import { deleteDialog } from "./view-dialogs"

// `DashboardList` (apps/web/src/components/dashboard-builder/list/dashboard-list.tsx).

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

/** `ListSectionHeader`: heading, count, rule, note. */
export const listSectionHeader = (
	h: H,
	options: Readonly<{ title: string; count: number; accent?: boolean; note?: string; className?: string }>,
): Html =>
	h.div(
		[h.Class(cn("flex items-center gap-2 pb-2", options.className))],
		[
			eyebrow(h, { variant: "label", as: "h3" }, [options.title]),
			h.span(
				[
					h.Class(
						cn(
							"font-mono text-2xs",
							options.accent === true ? "text-primary" : "text-muted-foreground",
						),
					),
				],
				[String(options.count)],
			),
			h.span([h.AriaHidden(true), h.Class("h-px grow bg-border")], []),
			...(options.note === undefined
				? []
				: [h.span([h.Class("text-muted-foreground text-2xs")], [options.note])]),
		],
	)

/** `ToolbarSearch` (`SearchInput`, default size). */
const toolbarSearch = (h: H, draft: string): Html =>
	inputGroup(h, { className: cn("max-w-sm", "min-w-0 grow sm:max-w-70") }, [
		inputGroupAddon(h, {}, [icon(h, "MagnifierIcon")]),
		inputGroupInput(h, {
			id: "dashboards-search",
			size: "default",
			type: "text",
			attributes: [
				h.Placeholder("Search dashboards"),
				h.Value(draft),
				h.OnInput((value) => Message.ChangedSearchDraft({ value })),
			],
		}),
		...(draft === ""
			? []
			: [
					inputGroupAddon(h, { align: "inline-end" }, [
						inputGroupButton(
							h,
							{
								attributes: [
									h.AriaLabel("Clear search"),
									h.OnClick(Message.ChangedSearchDraft({ value: "" })),
								],
							},
							[icon(h, "XmarkIcon")],
						),
					]),
				]),
	])

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

/** `TagFilterMenu` with no tags in the org: disabled, with the reason as its tooltip. */
const tagFilter = (h: H, allTags: ReadonlyArray<string>, selected: ReadonlyArray<string>): Html =>
	allTags.length === 0
		? disabledReason(
				h,
				button(h, { variant: "outline", className: "shrink-0", isDisabled: true }, ["Tags"]),
			)
		: tagFilterTrigger(h, selected)

/**
 * `MultiSelectCombobox` (`mode="trigger"`), closed: the combobox trigger and Base UI's hidden input.
 * TODO(tags-filter): the popup (search, tag list, Clear tags) is not ported; the trigger is inert.
 */
const tagFilterTrigger = (h: H, selected: ReadonlyArray<string>): Html =>
	h.div(
		[h.Class("contents")],
		[
			button(
				h,
				{
					variant: "outline",
					size: "default",
					className: "shrink-0 gap-1.5",
					slot: "combobox-trigger",
					attributes: [
						h.AriaExpanded(false),
						h.AriaHasPopup("dialog"),
						h.AriaLabel("Tags"),
						...(selected.length === 0 ? [h.DataAttribute("placeholder", "")] : []),
						h.Role("combobox"),
						h.Tabindex(0),
					],
				},
				[
					"Tags",
					...(selected.length === 0
						? []
						: [
								h.span(
									[
										h.Class(
											cn(
												badgeVariants({
													className: "ml-1.5 h-4 px-1.5 py-0 font-mono text-4xs",
												}),
											),
										),
										h.DataAttribute("slot", "badge"),
									],
									[String(selected.length)],
								),
							]),
					icon(h, "ChevronDownIcon", { className: "text-muted-foreground" }),
				],
			),
			h.input([
				h.AriaHidden(true),
				h.Style({
					clipPath: "inset(50%)",
					overflow: "hidden",
					whiteSpace: "nowrap",
					border: "0px",
					padding: "0px",
					width: "1px",
					height: "1px",
					margin: "-1px",
					position: "fixed",
					top: "0px",
					left: "0px",
				}),
				h.Tabindex(-1),
				h.Value(selected.join(",")),
			]),
		],
	)

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
						button(h, { variant: "outline", className: "shrink-0", attributes: trigger }, [
							SORT_LABELS[sort],
						]),
					),
				),
		},
		toParentMessage: (message) => Message.GotSortMenuMessage({ message }),
	})
}

const toolbar = (h: H, model: Model, dashboards: ReadonlyArray<ListDashboard>, scoped: number): Html => {
	const isFiltering = queryOf(model.search).trim().length > 0 || tagsOf(model.search).length > 0
	return h.div(
		[
			h.Class(
				cn(
					"flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3",
					"justify-start gap-2 border-b-0 px-0 pt-0",
				),
			),
		],
		[
			toolbarSearch(h, model.searchDraft),
			segmentedSelect<Scope, Message>(h, {
				options: SCOPE_OPTIONS,
				value: scopeOf(model.search),
				onChange: (scope) => Message.ChangedScope({ scope }),
				ariaLabel: "Filter dashboards by favorite",
				className: "shrink-0",
			}),
			tagFilter(h, collectTags(dashboards), tagsOf(model.search)),
			sortMenu(h, model),
			h.span([h.Class("grow")], []),
			h.span(
				[h.Class("text-muted-foreground shrink-0 font-mono text-2xs")],
				[
					isFiltering || scopeOf(model.search) === "favorites"
						? `${scoped} of ${dashboards.length}`
						: `${dashboards.length} of ${dashboards.length}`,
				],
			),
		],
	)
}

const ROW_MENU_ENTRIES: ReadonlyArray<MenuView.MenuEntry> = [
	{
		_tag: "Group",
		entries: [
			{ _tag: "Item", value: "export", label: "Export JSON" },
			{ _tag: "Item", value: "duplicate", label: "Duplicate" },
			{ _tag: "Item", value: "tags", label: "Edit tags…" },
			{ _tag: "Separator" },
			{ _tag: "Item", value: "delete", label: "Delete…", variant: "destructive" },
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
			entries: ROW_MENU_ENTRIES,
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
	const widgets = `${dashboard.widgetCount} ${dashboard.widgetCount === 1 ? "widget" : "widgets"}`
	const name = displayName(dashboard.name)
	return h.keyed("div")(
		dashboard.id,
		[
			h.Class(
				"group relative flex items-center border-b border-border last:border-b-0 transition-colors hover:bg-muted/50 focus-within:bg-muted/50",
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
					relativeTimeOrDate(h, {
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
							className: isFavorite ? "text-primary" : "text-muted-foreground/40",
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
				"mt-4 flex w-full shrink-0 items-center gap-3 rounded-md border border-dashed border-input bg-card py-3 pr-4 pl-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50",
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
			icon(h, "ArrowRightIcon", { size: 13, className: "text-muted-foreground shrink-0" }),
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
				emptyMedia(h, { variant: "icon" }, [icon(h, "MagnifierIcon", { size: 17 })]),
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
				emptyMedia(h, { variant: "icon" }, [icon(h, "StarIcon", { size: 17 })]),
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
	const isReadOnly = model.persistenceError !== null
	const context: RowContext = { model, nowMs, timeZone }
	const body: ReadonlyArray<Html> = isNothingAtAll
		? [firstRunEmpty(h, isReadOnly)]
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
						createRow(h, isReadOnly),
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
