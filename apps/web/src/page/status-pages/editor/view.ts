import type { StatusPageComponentStatus } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { skeleton } from "@maple/views/ui/skeleton"
import { tooltipTrigger } from "@maple/views/ui/tooltip-host"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailActions, detailTitle, detailTitleSkeleton } from "../../kit/detail-header"
import { relativeTime } from "../../kit/relative-time"
import { linkTabStrip } from "../../kit/underline-tabs"
import type * as Dialog from "@maple/views/ui/dialog"
import { sidePanelSheet } from "@maple/views/ui/sheet"
import { statusPageHref, statusPagesHref, statusPageViewHref } from "../shared/commands"
import { statusPageNotFound } from "../shared/not-found"
import { pageUrlOf } from "./update-domain"
import {
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_TONE,
	hasUnpublishedChanges,
	pageStatus,
} from "../shared/derive"
import { Message } from "./message"
import { canBreakGlass, canManage, canPostIncidents, type Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf, pageOf, statusReadsReady } from "./reads"
import { type EditorTab, PAGE_MENU_ID, resolveView } from "./update"
import { livePage } from "./view-canvas"
import { incidentsTab, maintenanceTab, openIncidentCount } from "./view-incidents"
import { addressLine, liveView } from "./view-live"
import { addSheetBody, addSheetFooter, incidentSheetBody, type TimeInputs } from "./view-panel"
import { breakGlassDialog, deletePageDialog, sectionLabel, settingsView } from "./view-settings"
import { removeCustomDomainDialog } from "./view-domain"
import { incidentDialogs } from "./view-incident-dialogs"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

// `/status-pages/$pageId`: the header and tabs, then the live page, its incidents, its maintenance,
// its settings, or the screen right after it went live.

type H = HtmlBuilder<Message>

/** The banner a visitor sees now: the worst component, from what is loaded. */
const overallOf = (model: Model): StatusPageComponentStatus =>
	pageStatus(componentsOf(model), monitorsOf(model), incidentsOf(model))

/** Where the page stands with visitors: live since when, a draft, or changes on their way. */
const stateLine = (h: H, model: Model, page: V2StatusPage, timeZone: string): Html => {
	const className = typographyClass({ size: "xs", tone: "muted" })
	if (page.draft) return h.span([h.Class(className)], ["Draft. Nothing is public until you publish."])
	if (page.last_publish_error !== null)
		return typography(h, { size: "xs", tone: "destructive" }, [
			`Last publish failed: ${page.last_publish_error}`,
		])
	if (page.published_at === null) return h.span([h.Class(className)], ["Publishing within a minute"])
	if (hasUnpublishedChanges(page)) return h.span([h.Class(className)], ["Changes go out within a minute"])
	return h.span(
		[h.Class(className)],
		[
			relativeTime(h, {
				value: page.published_at,
				nowMs: model.nowMs ?? 0,
				timeZone,
				prefix: "Live, published",
			}),
		],
	)
}

/** An internal page has no public address to post to, so it has no break-glass token. */
const menuEntries = (model: Model, page: V2StatusPage): ReadonlyArray<MenuEntry> => {
	const hasBreakGlass = canBreakGlass(model) && page.visibility !== "internal"
	return [
		...(hasBreakGlass
			? ([{ _tag: "Item", value: "break-glass", label: "Break-glass token", icon: "KeyIcon" }] as const)
			: []),
		...(canManage(model)
			? ([
					...(hasBreakGlass ? ([{ _tag: "Separator" }] as const) : []),
					{
						_tag: "Item",
						value: "delete",
						label: "Delete",
						icon: "TrashIcon",
						variant: "destructive",
					},
				] as const)
			: []),
	]
}

const publishButton = (h: H, model: Model): Html =>
	button(
		h,
		{
			size: "sm",
			isLoading: model.isPublishing,
			attributes: [h.OnClick(Message.ClickedPublish())],
		},
		[icon(h, "PaperPlaneIcon"), "Publish page"],
	)

/** The public page in a new tab; disabled, with the reason on hover, while it has no address. */
const openPageButton = (h: H, model: Model, page: V2StatusPage): Html => {
	const url = pageUrlOf(model, page)
	const label = [icon(h, "ExternalLinkIcon"), "Open page"]
	if (page.visibility === "internal")
		return linkButton(h, { size: "sm", variant: "outline", href: statusPageViewHref(page.id) }, [
			icon(h, "EyeIcon"),
			"Open page",
		])
	if (url !== null && !page.draft)
		return linkButton(
			h,
			{
				size: "sm",
				variant: "outline",
				href: url,
				attributes: [h.Target("_blank"), h.Rel("noopener")],
			},
			label,
		)
	// A disabled button fires no hover, so its wrapper carries the reason as a tooltip.
	return h.span(
		tooltipTrigger(
			h,
			url === null ? "No status domain is configured yet" : "Publish the page to open it",
		),
		[button(h, { size: "sm", variant: "outline", isDisabled: true }, label)],
	)
}

/** Incidents and Maintenance lead with posting one; the other tabs with the page itself. */
const headerActions = (h: H, model: Model, page: V2StatusPage): Html => {
	const tab = resolveView(model.search).tab
	if (tab === "incidents" || tab === "maintenance")
		return detailActions(
			h,
			canPostIncidents(model)
				? [
						button(
							h,
							{
								size: "sm",
								attributes: [
									h.OnClick(
										Message.ClickedNewIncident({
											kind: tab === "incidents" ? "incident" : "maintenance",
										}),
									),
								],
							},
							tab === "incidents"
								? [icon(h, "PlusIcon"), "Declare incident"]
								: [icon(h, "CalendarIcon"), "Schedule maintenance"],
						),
					]
				: [],
		)
	const entries = menuEntries(model, page)
	return detailActions(h, [
		...(canManage(model) && page.draft ? [publishButton(h, model)] : []),
		openPageButton(h, model, page),
		...(entries.length === 0
			? []
			: [
					rowActionsMenu(h, {
						slotId: PAGE_MENU_ID,
						model: model.pageMenu,
						entries,
						label: "Page actions",
						toParentMessage: (message) => Message.GotPageMenuMessage({ message }),
					}),
				]),
	])
}

const TAB_LABELS = {
	page: "Live page",
	incidents: "Incidents",
	maintenance: "Maintenance",
	settings: "Settings",
} as const satisfies Record<Exclude<EditorTab, "live">, string>

const TABS = ["page", "incidents", "maintenance", "settings"] as const

const tabs = (h: H, model: Model, page: V2StatusPage): Html => {
	const current = resolveView(model.search).tab
	const open = openIncidentCount(model)
	return linkTabStrip(
		h,
		"Status page views",
		Arr.map(TABS, (tab) => ({
			key: tab,
			href: statusPageHref(page.id, tab === "page" ? undefined : tab),
			label: TAB_LABELS[tab],
			count: tab === "incidents" && open > 0 ? open : undefined,
			countTone: "error",
			isCurrent: current === tab,
			isRouteActive: current === tab,
		})),
	)
}

/** Over a draft's live page: nothing is public yet, and Publish page in the header changes that. */
const draftCallout = (h: H): Html =>
	alert(h, { variant: "info", size: "sm", role: "status" }, [
		icon(h, "LockIcon"),
		alertTitle(h, ["This page is a draft"]),
		alertDescription(h, [
			"Visitors can't see it yet. Add your monitors and pick a look under Settings, then click Publish page.",
		]),
	])

/** The reads the page view waits on: statuses need monitors and incidents too. */
const canvasRead = (model: Model): { failure: Option.Option<LoadFailure>; isReady: boolean } => ({
	failure: AsyncData.getError(model.components.data).pipe(
		Option.orElse(() => AsyncData.getError(model.monitors.data)),
		Option.orElse(() => AsyncData.getError(model.incidents.data)),
	),
	isReady: statusReadsReady(model),
})

/** The statuses' reads failed, or are still on their way: the tabs that list or draw them wait. */
const awaitingReads = (h: H, model: Model): Html | null => {
	const read = canvasRead(model)
	if (Option.isSome(read.failure))
		return errorState(h, {
			failure: read.failure.value,
			title: "Couldn't load the page's components",
			onRetry: Message.ClickedRetry(),
			className: "py-12",
		})
	return read.isReady ? null : h.div([h.AriaBusy(true)], [skeleton(h, "h-[560px] w-full")])
}

const body = (h: H, model: Model, page: V2StatusPage, time: TimeInputs): Html => {
	const location = resolveView(model.search)
	if (location.tab === "live") return liveView(h, model, page)
	if (location.tab === "settings" && location.section !== "monitors")
		return settingsView(h, model, page, location.section)
	const waiting = awaitingReads(h, model)
	if (waiting !== null) return waiting
	switch (location.tab) {
		case "settings":
			return settingsView(h, model, page, location.section)
		case "incidents":
			return incidentsTab(h, model, time)
		case "maintenance":
			return maintenanceTab(h, model, time)
		case "page":
			return canManage(model) && page.draft
				? vstack(h, { gap: "4" }, [draftCallout(h), livePage(h, model, page)])
				: livePage(h, model, page)
	}
}

/** The side sheet: the open incident, or Add monitors; it keeps its last content while it closes. */
const panelSheet = (h: H, model: Model, time: TimeInputs): Html => {
	const panel = model.sheetPanel
	const toParentMessage = (message: Dialog.Message) => Message.GotPanelSheetMessage({ message })
	if (panel?._tag === "Add")
		return sidePanelSheet(h, {
			sheet: model.panelSheet,
			title: "Add monitors",
			body: addSheetBody(h, model),
			footer: (close) => addSheetFooter(h, model, close),
			toParentMessage,
		})
	const id = panel?._tag === "Incident" ? panel.incidentId : null
	const listed = Option.getOrUndefined(Arr.findFirst(incidentsOf(model), (row) => row.id === id))
	// A closing sheet (its incident just deleted) keeps what it showed.
	const kept = model.panel === null && model.sheetIncident?.id === id ? model.sheetIncident : undefined
	const incident = listed ?? kept
	return sidePanelSheet(h, {
		sheet: model.panelSheet,
		title: incident?.title ?? "Incident",
		body:
			incident === undefined
				? [missingIncident(h, model)]
				: incidentSheetBody(h, model, incident, time),
		toParentMessage,
	})
}

/** The sheet's incident is not in the list: still being read, the read failed, or it is gone. */
const missingIncident = (h: H, model: Model): Html => {
	const data = model.incidents.data
	if (AsyncData.isPending(data)) return h.div([h.AriaBusy(true)], [skeleton(h, "h-48 w-full")])
	return Option.match(AsyncData.getError(data), {
		onSome: (failure) =>
			errorState(h, { failure, title: "Couldn't load the incident", onRetry: Message.ClickedRetry() }),
		onNone: () =>
			typography(h, { size: "sm", tone: "muted", as: "p" }, [
				"This incident is no longer on the page.",
			]),
	})
}

/** What removing it does: a draft has no visitors yet, and only a monitored component has a monitor. */
export const removeComponentCopy = (
	page: V2StatusPage,
	component: Readonly<{ monitor_id: string | null }> | undefined,
): string =>
	Arr.join(
		[
			page.draft
				? "It leaves the draft; visitors never see it."
				: "Visitors stop seeing it within a minute.",
			...(component?.monitor_id === null || component === undefined
				? []
				: ["Its monitor keeps running."]),
		],
		" ",
	)

const deleteComponentDialog = (h: H, model: Model, page: V2StatusPage): Html => {
	const component = Option.getOrUndefined(
		Arr.findFirst(componentsOf(model), (row) => row.id === model.confirmDeleteComponentId),
	)
	return confirmDialog(h, {
		slotId: "status-page-delete-component",
		model: model.deleteComponentDialog,
		toParentMessage: (message) => Message.GotDeleteComponentDialogMessage({ message }),
		title: `Remove ${component?.name ?? "this component"} from the page?`,
		description: removeComponentCopy(page, component),
		confirmLabel: "Remove from page",
		isPending: model.isDeletingComponent,
		onConfirm: Message.ClickedConfirmDeleteComponent(),
	})
}

const deleteIncidentDialog = (h: H, model: Model, page: V2StatusPage): Html => {
	const incident = Option.getOrUndefined(
		Arr.findFirst(incidentsOf(model), (row) => row.id === model.confirmDeleteIncidentId),
	)
	const isMaintenance = incident?.kind === "maintenance"
	return confirmDialog(h, {
		slotId: "status-page-delete-incident",
		model: model.deleteIncidentDialog,
		toParentMessage: (message) => Message.GotDeleteIncidentDialogMessage({ message }),
		title: `Delete ${incident?.title ?? "this incident"}?`,
		description:
			page.draft || incident?.published === false
				? "It and its updates are removed. This can't be undone."
				: "It and its updates leave the public page and its history within a minute. This can't be undone.",
		confirmLabel: isMaintenance ? "Delete maintenance" : "Delete incident",
		isPending: model.isDeletingIncident,
		onConfirm: Message.ClickedConfirmDeleteIncident(),
	})
}

const loaded = (h: H, model: Model, page: V2StatusPage, inputs: PageViewInputs): Html => {
	const timeZone = inputs.context.timeZone
	const time = { nowMs: model.nowMs ?? 0, timeZone }
	const overall = overallOf(model)
	const hasStatus = canvasRead(model).isReady && componentsOf(model).length > 0
	return h.div(
		[h.Class("contents")],
		[
			dashboardPage(
				h,
				{
					titleContent: detailTitle(h, {
						kind: ["Status page"],
						title: [page.name],
						adornment: page.draft
							? badge(h, { variant: "meta" }, ["Draft, not public"])
							: hasStatus
								? badge(h, { variant: COMPONENT_STATUS_TONE[overall] }, [
										COMPONENT_STATUS_LABEL[overall],
									])
								: h.empty,
						meta: [
							hstack(
								h,
								{ align: "center", wrap: true, as: "span", className: "gap-x-3 gap-y-1" },
								[stateLine(h, model, page, timeZone), addressLine(h, model, page)],
							),
						],
					}),
					actions: headerActions(h, model, page),
					tabs: tabs(h, model, page),
					gap: "md",
				},
				[body(h, model, page, time)],
			),
			panelSheet(h, model, time),
			deleteComponentDialog(h, model, page),
			...incidentDialogs(h, model, page, time),
			deleteIncidentDialog(h, model, page),
			breakGlassDialog(h, model),
			deletePageDialog(h, model, page),
			removeCustomDomainDialog(h, model),
		],
	)
}

const notFound = (h: H, model: Model): Html => dashboardPage(h, {}, [statusPageNotFound(h, model.rawPageId)])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	if (model.pageId === null) return notFound(h, model)
	const data = model.page.data
	if (AsyncData.isFailure(data))
		return data.error.code === "status_page_not_found"
			? notFound(h, model)
			: dashboardPage(h, {}, [
					errorState(h, {
						failure: data.error,
						title: "Couldn't load the status page",
						onRetry: Message.ClickedRetry(),
					}),
				])
	return Option.match(pageOf(model), {
		onNone: () =>
			dashboardPage(h, { titleContent: detailTitleSkeleton(h) }, [
				skeleton(h, "h-9 w-1/2"),
				skeleton(h, "h-48 w-full"),
			]),
		onSome: (page) => loaded(h, model, page, inputs),
	})
})

/** The H1 names the page; a tab adds its name, and Settings its section. */
export const breadcrumbsOf = (model: Model) => {
	const page = Option.getOrUndefined(pageOf(model))
	const { tab, section } = resolveView(model.search)
	return [
		{ label: "Status pages", href: statusPagesHref() },
		...(page === undefined
			? []
			: tab === "page" || tab === "live"
				? [{ label: page.name }]
				: [
						{ label: page.name, href: statusPageHref(page.id) },
						...(tab === "settings"
							? [
									{ label: TAB_LABELS.settings, href: statusPageHref(page.id, "settings") },
									{ label: sectionLabel(section) },
								]
							: [{ label: TAB_LABELS[tab] }]),
					]),
	]
}
