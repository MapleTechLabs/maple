import type { StatusPageComponentStatus, StatusPageVisibility } from "@maple/domain"
import type { V2StatusPageIncident } from "@maple/domain/http/v2"
import { isStatusPageImageSource } from "@maple/domain/status-page"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import * as Menu from "@maple/views/ui/menu"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { panel } from "@maple/views/ui/panel"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { selectableRow } from "@maple/views/ui/selectable-row"
import { ROW_LINK_LIFT, rowLink } from "@maple/views/ui/table"
import { skeleton } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { textLink } from "@maple/views/ui/text-link"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { relativeTime } from "../../kit/relative-time"
import { docsLink } from "../../kit/signal-empty-state"
import { formatDaysUptime } from "../../kit/uptime/derive"
import { monitorHref } from "../../kit/uptime/commands"
import { uptimeDaysStrip } from "../../kit/uptime/view"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import {
	newStatusPageHref,
	publicAddress,
	publicAddressOf,
	publicPageLink,
	publicUrlOf,
	STATUS_PAGE_BASE_URL,
	statusPageHref,
} from "../shared/commands"
import { openMenuEntries } from "../shared/open-page"
import {
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_TONE,
	SUMMARY_UPTIME_DAYS,
	type StatusPageSummary,
	type SummaryComponent,
} from "../shared/derive"
import { windowLine } from "../editor/view-panel"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { rowMenuId } from "./update"
import { gatedControl } from "../../kit/session-grants"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { stripClass } from "@maple/views/ui/rule"

// `/status-pages`: one card per page with its components as visitors see them, their daily
// uptime, open incidents and the next maintenance; the builder's on-ramp when there is none.

type H = HtmlBuilder<Message>
type ViewInputs = Readonly<{ nowMs: number; timeZone: string; orgKey: Option.Option<string> }>

/** The builder link; a disabled button for a viewer who may not edit status pages. */
const newPageButton = (h: H, model: Model, label: string): Html =>
	gatedControl(h, model, "status_pages:edit", (isDisabled) => {
		const children = [icon(h, "PlusIcon"), label]
		return isDisabled
			? button(h, { size: "sm", isDisabled }, children)
			: linkButton(h, { size: "sm", href: newStatusPageHref() }, children)
	})

// EMPTY

const EXAMPLE_POINTS = [
	"Components follow your uptime monitors, with daily uptime bars.",
	"You post incidents and planned maintenance; visitors can subscribe.",
	"Served apart from Maple, so it stays up when Maple does not.",
] as const

/** No page yet: what a status page is, the docs and the builder. */
const emptyState = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(
				h,
				[
					emptyMedia(h, { variant: "icon" }, [icon(h, "WindowChartLineIcon", { size: 18 })]),
					emptyTitle(h, ["No status pages yet"]),
					emptyDescription(h, [
						"A status page tells your customers whether your product works: a hosted page with your components' current status and uptime, open incidents and planned maintenance.",
					]),
				],
				"max-w-lg",
			),
			emptyContent(
				h,
				[
					vstack(
						h,
						{ gap: "2", as: "ul", className: "text-left" },
						Arr.map(EXAMPLE_POINTS, (point) =>
							hstack(h, { gap: "2", align: "start", as: "li" }, [
								icon(h, "CheckIcon", {
									size: 14,
									className: "mt-0.5 shrink-0 text-severity-info",
								}),
								typography(h, { size: "sm", tone: "muted" }, [point]),
							]),
						),
					),
					emptyActions(h, [
						newPageButton(h, model, "Create a status page"),
						docsLink(h, "statusPages", "How status pages work"),
					]),
				],
				"max-w-lg gap-6",
			),
		],
		emptyFrameClass("dashed"),
	)

// CARD HEADER

/** Who can read each page, at a glance. */
const VISIBILITY_BADGE = {
	public: { label: "Public", variant: "ok" },
	password: { label: "Password", variant: "warn" },
	internal: { label: "Internal", variant: "done" },
} as const satisfies Record<StatusPageVisibility, { label: string; variant: "ok" | "warn" | "done" }>

const lastPublished = (h: H, summary: StatusPageSummary, inputs: ViewInputs): Html => {
	const page = summary.page
	if (page.draft) return badge(h, { variant: "meta" }, ["Draft"])
	if (page.last_publish_error !== null)
		return typography(
			h,
			{ size: "xs", tone: "destructive", attributes: [h.Title(page.last_publish_error)] },
			["Publish failed"],
		)
	if (page.published_at === null) return typography(h, { size: "xs", tone: "muted" }, ["Not published"])
	return typography(h, { size: "xs", tone: "muted", as: "span" }, [
		"Published ",
		relativeTime(h, { value: page.published_at, nowMs: inputs.nowMs, timeZone: inputs.timeZone }),
	])
}

/** Open public page and Open dev preview for everyone; Edit and Delete for those who may change the page. */
const pageMenuEntries = (
	summary: StatusPageSummary,
	orgKey: Option.Option<string>,
	isEditable: boolean,
): ReadonlyArray<MenuEntry> => {
	const page = summary.page
	const open = openMenuEntries(publicPageLink(page, publicUrlOf(STATUS_PAGE_BASE_URL, orgKey, page.slug)))
	if (!isEditable) return open
	return [
		...open,
		{ _tag: "Separator" },
		{ _tag: "Item", value: "edit", label: "Edit", icon: "PencilIcon" },
		{ _tag: "Separator" },
		{ _tag: "Item", value: "delete", label: "Delete", icon: "TrashIcon", variant: "destructive" },
	]
}

const pageMenu = (
	h: H,
	model: Model,
	summary: StatusPageSummary,
	orgKey: Option.Option<string>,
	isEditable: boolean,
): Html => {
	const menuId = rowMenuId(summary.page.id)
	return rowActionsMenu(h, {
		slotId: menuId,
		model: model.rowMenus[menuId] ?? Menu.init(menuId),
		entries: pageMenuEntries(summary, orgKey, isEditable),
		label: `Actions for ${summary.page.name}`,
		toParentMessage: (message) => Message.GotRowMenuMessage({ pageId: summary.page.id, message }),
	})
}

/** The page's favicon beside its name, when it has one the page would render. */
const pageIcon = (h: H, favicon: string | null): ReadonlyArray<Html> =>
	favicon !== null && isStatusPageImageSource(favicon)
		? [h.img([h.Src(favicon), h.Alt(""), h.Class("size-4 shrink-0 rounded-2xs object-contain")])]
		: []

/** The address visitors open, a link while the page is served; an internal page has none. */
const pageAddress = (h: H, summary: StatusPageSummary, orgKey: Option.Option<string>): Html => {
	const page = summary.page
	if (page.visibility === "internal")
		return typography(h, { size: "xs", tone: "muted", truncate: true }, ["Members only, in Maple"])
	if (Option.isNone(orgKey))
		// A blank line of the same height until the org key lands, so the row does not shift.
		return typography(h, { size: "xs", mono: true, truncate: true }, ["\u00a0"])
	const text = publicAddress(orgKey.value, page.slug)
	const link = publicPageLink(page, publicUrlOf(STATUS_PAGE_BASE_URL, orgKey, page.slug))
	const address = typography(h, { size: "xs", mono: true, truncate: true, as: "span" }, [text])
	return link._tag === "Open"
		? textLink(
				h,
				{
					href: link.url,
					tone: "muted",
					className: cn("min-w-0", ROW_LINK_LIFT),
					attributes: [h.Target("_blank"), h.Rel("noopener")],
				},
				[address],
			)
		: typography(
				h,
				{ size: "xs", tone: "muted", mono: true, truncate: true, attributes: [h.Title(link.reason)] },
				[text],
			)
}

const cardHeader = (
	h: H,
	model: Model,
	summary: StatusPageSummary,
	inputs: ViewInputs,
	isEditable: boolean,
): Html => {
	const page = summary.page
	const visibility = VISIBILITY_BADGE[page.visibility]
	return hstack(
		h,
		{
			gap: "4",
			align: "start",
			justify: "between",
			className: stripClass(
				"header",
				// Tinted while either header link is hovered, not the address or the menu above them.
				"relative has-[[data-header-link]:hover]:bg-surface-sunken has-[[data-header-link]:active]:bg-surface-sunken",
			),
		},
		[
			vstack(h, { gap: "1", className: "min-w-0" }, [
				// The whole header opens the editor (an overlay link), but only the icon and title
				// react to the pointer; the overlay stays out of the accessibility tree and tab order.
				rowLink(h, {
					href: statusPageHref(page.id),
					attributes: [h.DataAttribute("header-link", ""), h.AriaHidden(true), h.Tabindex(-1)],
				}),
				heading(h, { level: 2, variant: "section", className: "min-w-0" }, [
					textLink(
						h,
						{
							href: statusPageHref(page.id),
							tone: "inherit",
							className: cn("max-w-full gap-2", ROW_LINK_LIFT),
							attributes: [h.DataAttribute("header-link", "")],
						},
						[
							...pageIcon(h, page.favicon_url),
							typography(h, { truncate: true, as: "span" }, [page.name]),
						],
					),
				]),
				pageAddress(h, summary, inputs.orgKey),
			]),
			hstack(h, { gap: "3", align: "center", className: "shrink-0" }, [
				badge(h, { variant: visibility.variant, size: "xs" }, [visibility.label]),
				lastPublished(h, summary, inputs),
				h.div([h.Class(ROW_LINK_LIFT)], [pageMenu(h, model, summary, inputs.orgKey, isEditable)]),
			]),
		],
	)
}

// STATUS STRIP

/** The banner a visitor reads first, worded for the whole page. */
const OVERALL_LABEL = {
	operational: "All systems operational",
	degraded: "Degraded performance",
	partial_outage: "Partial outage",
	major_outage: "Major outage",
	maintenance: "Under maintenance",
} as const satisfies Record<StatusPageComponentStatus, string>

const draftMark = (h: H, incident: V2StatusPageIncident): ReadonlyArray<Html> =>
	incident.published ? [] : [badge(h, { variant: "meta", size: "xs" }, ["Draft"])]

const incidentsLine = (h: H, summary: StatusPageSummary): Html | null => {
	const [first, ...rest] = summary.openIncidents
	if (first === undefined) return null
	return hstack(h, { gap: "2", align: "center", className: "min-w-0" }, [
		icon(h, "CircleWarningIcon", { size: 14, className: "shrink-0 text-severity-warn" }),
		textLink(
			h,
			{ href: statusPageHref(summary.page.id, "incidents"), tone: "inherit", className: "min-w-0" },
			[typography(h, { size: "sm", truncate: true }, [first.title])],
		),
		...draftMark(h, first),
		...(rest.length === 0
			? []
			: [
					typography(h, { size: "xs", tone: "muted" }, [
						`+${countLabel(rest.length, "more incident")}`,
					]),
				]),
	])
}

const maintenanceLine = (h: H, summary: StatusPageSummary, inputs: ViewInputs): Html | null => {
	const maintenance = summary.maintenance
	if (maintenance === null) return null
	const window = windowLine(h, maintenance, inputs.timeZone)
	return hstack(h, { gap: "2", align: "center", className: "min-w-0" }, [
		icon(h, "CalendarIcon", { size: 14, className: "shrink-0 text-severity-info" }),
		typography(h, { size: "xs", tone: "muted", className: "shrink-0" }, [
			maintenance.status === "in_progress" ? "Maintenance now" : "Next maintenance",
		]),
		textLink(
			h,
			{ href: statusPageHref(summary.page.id, "maintenance"), tone: "inherit", className: "min-w-0" },
			[typography(h, { size: "sm", truncate: true }, [maintenance.title])],
		),
		...(window === null ? [] : [typography(h, { size: "xs", tone: "muted", as: "span" }, window)]),
		...draftMark(h, maintenance),
	])
}

const statusStrip = (h: H, summary: StatusPageSummary, inputs: ViewInputs): Html => {
	const tone = summary.components.length === 0 ? "neutral" : COMPONENT_STATUS_TONE[summary.overall]
	const lines = Arr.filter(
		[incidentsLine(h, summary), maintenanceLine(h, summary, inputs)],
		(line): line is Html => line !== null,
	)
	return hstack(
		h,
		{ gap: "6", align: "center", wrap: true, className: stripClass("bar", "gap-y-2 px-4") },
		[
			hstack(h, { gap: "2", align: "center", className: "shrink-0" }, [
				statusDot(h, { tone, size: "lg" }),
				typography(h, { size: "sm", weight: "medium" }, [
					summary.components.length === 0 ? "No components yet" : OVERALL_LABEL[summary.overall],
				]),
			]),
			...lines,
		],
	)
}

// COMPONENTS

const COMPONENT_GRID =
	"grid grid-cols-[minmax(140px,1fr)_minmax(180px,2.4fr)_72px_120px] items-center gap-x-5"

/** Components under their group headings, in page order; a group shows where it first appears. */
const groupsOf = (
	components: ReadonlyArray<SummaryComponent>,
): ReadonlyArray<Readonly<{ group: string | null; components: ReadonlyArray<SummaryComponent> }>> =>
	Arr.reduce(
		components,
		[] as ReadonlyArray<Readonly<{ group: string | null; components: ReadonlyArray<SummaryComponent> }>>,
		(groups, component) =>
			Arr.some(groups, (entry) => entry.group === component.group)
				? Arr.map(groups, (entry) =>
						entry.group === component.group
							? { ...entry, components: [...entry.components, component] }
							: entry,
					)
				: [...groups, { group: component.group, components: [component] }],
	)

/** A monitored component's row opens its uptime monitor and checks. */
const componentRow = (h: H, component: SummaryComponent): Html => {
	const uptime = formatDaysUptime(component.days)
	return selectableRow(
		h,
		{
			isSelected: false,
			href: component.monitorId === null ? undefined : monitorHref(component.monitorId),
			className: cn(
				COMPONENT_GRID,
				"px-4 py-2",
				component.monitorId !== null && "hover:bg-surface-sunken active:bg-surface-sunken",
			),
			attributes: [h.Key(component.id)],
		},
		[
			hstack(h, { gap: "2", align: "center", className: "min-w-0" }, [
				statusDot(h, { tone: COMPONENT_STATUS_TONE[component.status] }),
				typography(h, { size: "sm", truncate: true }, [component.name]),
			]),
			component.days.length === 0
				? typography(h, { size: "xs", tone: "muted" }, [
						component.monitored ? "Uptime hidden on the page" : "No monitor: set by hand",
					])
				: uptimeDaysStrip(h, {
						days: component.days,
						label: `${component.name}: ${uptime ?? "no checks"} over the last ${SUMMARY_UPTIME_DAYS} days`,
					}),
			typography(h, { size: "xs", mono: true, numeric: true, tone: "muted", className: "text-right" }, [
				uptime ?? "–",
			]),
			typography(
				h,
				{
					size: "xs",
					className: cn(
						"text-right",
						component.status === "operational" ? "text-muted-foreground" : undefined,
					),
				},
				[COMPONENT_STATUS_LABEL[component.status]],
			),
		],
	)
}

const componentsTable = (h: H, summary: StatusPageSummary): Html =>
	h.div(
		[h.Class("overflow-x-auto")],
		[
			h.div(
				[h.Class("min-w-[640px] pb-1")],
				[
					h.div(
						[h.Class(cn(COMPONENT_GRID, "px-4 pt-3 pb-1"))],
						[
							eyebrow(h, {}, ["Component"]),
							hstack(h, { justify: "between" }, [
								eyebrow(h, {}, [`${SUMMARY_UPTIME_DAYS} days ago`]),
								eyebrow(h, {}, ["Today"]),
							]),
							eyebrow(h, { className: "text-right" }, ["Uptime"]),
							eyebrow(h, { className: "text-right" }, ["Status"]),
						],
					),
					...Arr.flatMap(groupsOf(summary.components), ({ group, components }) => [
						...(group === null
							? []
							: [
									typography(
										h,
										{
											size: "xs",
											weight: "medium",
											tone: "muted",
											className: "px-4 pt-3 pb-1",
										},
										[group],
									),
								]),
						...Arr.map(components, (component) => componentRow(h, component)),
					]),
				],
			),
		],
	)

const noComponents = (h: H, summary: StatusPageSummary): Html =>
	typography(h, { size: "sm", tone: "muted", as: "p", className: "px-4 py-4" }, [
		"Nothing on this page yet. ",
		textLink(h, { href: statusPageHref(summary.page.id, "settings", "monitors") }, ["Add components"]),
	])

const pageCard = (
	h: H,
	model: Model,
	summary: StatusPageSummary,
	inputs: ViewInputs,
	isEditable: boolean,
): Html =>
	panel(h, { attributes: [h.Key(summary.page.id)] }, [
		cardHeader(h, model, summary, inputs, isEditable),
		statusStrip(h, summary, inputs),
		summary.components.length === 0 ? noComponents(h, summary) : componentsTable(h, summary),
	])

const body = (h: H, model: Model, inputs: ViewInputs): Html => {
	const data = model.pages.data
	if (AsyncData.isFailure(data))
		return errorState(h, {
			failure: data.error,
			title: "Couldn't load status pages",
			onRetry: Message.ClickedRetry(),
			className: "py-12",
		})
	return Option.match(AsyncData.getData(data), {
		onNone: () => vstack(h, { gap: "4" }, [skeleton(h, "h-9 w-1/3"), skeleton(h, "h-64 w-full")]),
		onSome: (pages) =>
			pages.length === 0
				? emptyState(h, model)
				: vstack(
						h,
						{ gap: "4" },
						Arr.map(pages, (summary) => pageCard(h, model, summary, inputs, canManage(model))),
					),
	})
}

const deleteDialog = (h: H, model: Model, orgKey: Option.Option<string>): Html => {
	const page = Option.map(
		Option.flatMap(Option.fromNullishOr(model.deletingPageId), (id) =>
			Arr.findFirst(
				AsyncData.getOrElse(model.pages.data, () => []),
				(row) => row.page.id === id,
			),
		),
		(row) => row.page,
	)
	return confirmDialog(h, {
		slotId: "status-pages-delete",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: `Delete ${Option.match(page, { onNone: () => "this status page", onSome: (p) => p.name })}?`,
		description: `${Option.match(page, { onNone: () => "The page", onSome: (p) => Option.getOrElse(publicAddressOf(orgKey, p.slug), () => p.name) })} goes offline and its components and incidents are deleted. This cannot be undone.`,
		confirmLabel: "Delete status page",
		isPending: model.isDeleting,
		onConfirm: Message.ClickedConfirmDelete(),
	})
}

const hasPages = (model: Model): boolean =>
	Option.match(AsyncData.getData(model.pages.data), {
		onNone: () => false,
		onSome: (pages) => pages.length > 0,
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		{
			title: "Status pages",
			actions: hasPages(model) ? newPageButton(h, model, "New status page") : undefined,
		},
		[
			body(h, model, {
				nowMs: model.nowMs ?? 0,
				timeZone: inputs.context.timeZone,
				orgKey: model.orgKey,
			}),
			deleteDialog(h, model, model.orgKey),
		],
	),
)
