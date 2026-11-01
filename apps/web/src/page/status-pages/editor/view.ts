import type { StatusPageComponentStatus } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { worstStatus } from "@maple/domain/status-page"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../data/load-failure"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import type { MenuEntry } from "../../../ui/menu-view"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailActions, detailTitle, detailTitleSkeleton } from "../../kit/detail-header"
import { relativeTime } from "../../kit/relative-time"
import { resourceNotFound } from "../../kit/resource-not-found"
import { linkTabStrip } from "../../kit/underline-tabs"
import { type EditorView, statusPageHref, statusPagesHref } from "../shared/commands"
import {
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_TONE,
	componentStatus,
	hasUnpublishedChanges,
} from "../shared/derive"
import { Message } from "./message"
import type { Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf, pageOf, statusReadsReady } from "./reads"
import { PAGE_MENU_ID, resolveView } from "./update"
import { canvas } from "./view-canvas"
import { jsonTab } from "./view-json"
import { addressLine, liveView } from "./view-live"
import { appearanceView, breakGlassDialog, deletePageDialog, settingsView } from "./view-settings"

// `/status-pages/$pageId`: the header and tabs, then the page as the editor, its Appearance, its
// Settings, its JSON, or the screen right after it went live.

type H = HtmlBuilder<Message>

/** The banner a visitor sees now: the worst component, from what is loaded. */
const overallOf = (model: Model): StatusPageComponentStatus =>
	worstStatus(
		componentsOf(model).map((component) =>
			componentStatus(component, monitorsOf(model), incidentsOf(model)),
		),
	)

/** Where the page stands with visitors: live since when, a draft, or changes on their way. */
const stateLine = (h: H, model: Model, page: V2StatusPage, timeZone: string): Html => {
	const className = "text-xs text-muted-foreground"
	if (page.draft) return h.span([h.Class(className)], ["Draft. Nothing is public until you publish."])
	if (page.last_publish_error !== null)
		return h.span(
			[h.Class("text-xs text-destructive")],
			[`Last publish failed: ${page.last_publish_error}`],
		)
	if (page.published_at === null) return h.span([h.Class(className)], ["Publishing within a minute"])
	if (hasUnpublishedChanges(page)) return h.span([h.Class(className)], ["Changes go out within a minute"])
	return h.span(
		[h.Class(className)],
		[
			relativeTime(h, {
				value: page.published_at,
				nowMs: model.nowMs ?? 0,
				timeZone,
				tooltip: "title",
				prefix: "Live, published",
			}),
		],
	)
}

const menuEntries = (model: Model, page: V2StatusPage): ReadonlyArray<MenuEntry> => [
	{
		_tag: "Item",
		value: "public",
		label: "View public page",
		icon: "ExternalLinkIcon",
		// A draft is not public, and without a status domain there is no address to open.
		isDisabled: page.draft || model.publicBaseUrl === "",
	},
	...(model.isAdmin
		? ([
				{ _tag: "Item", value: "break-glass", label: "Break-glass token", icon: "KeyIcon" },
				{ _tag: "Separator" },
				{ _tag: "Item", value: "delete", label: "Delete", icon: "TrashIcon", variant: "destructive" },
			] as const)
		: []),
]

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

/** A draft's next step is publishing it, so Publish leads and Post incident steps back. */
const headerActions = (h: H, model: Model, page: V2StatusPage): Html => {
	const canPublish = model.isAdmin && page.draft
	// The composer opens beside the page, so Post incident lives on the Page tab.
	const isPageView = resolveView(model.search.view) === "page"
	return detailActions(h, [
		...(isPageView
			? [
					button(
						h,
						{
							size: "sm",
							variant: canPublish ? "outline" : "default",
							attributes: [h.OnClick(Message.ClickedNewIncident({ kind: "incident" }))],
						},
						[icon(h, "PlusIcon"), "Post incident"],
					),
				]
			: []),
		...(canPublish ? [publishButton(h, model)] : []),
		rowActionsMenu(h, {
			slotId: PAGE_MENU_ID,
			model: model.pageMenu,
			entries: menuEntries(model, page),
			label: "Page actions",
			toParentMessage: (message) => Message.GotPageMenuMessage({ message }),
		}),
	])
}

const TAB_LABELS = {
	page: "Page",
	appearance: "Appearance",
	settings: "Settings",
	json: "JSON",
} as const satisfies Record<"page" | Exclude<EditorView, "live">, string>

const TABS = (["page", "appearance", "settings", "json"] as const).map((view) => ({
	view,
	label: TAB_LABELS[view],
}))

const tabs = (h: H, model: Model, page: V2StatusPage): Html => {
	const current = resolveView(model.search.view)
	return linkTabStrip(
		h,
		"Status page views",
		TABS.map((tab) => ({
			key: tab.view,
			href: statusPageHref(page.id, tab.view === "page" ? undefined : tab.view),
			label: tab.label,
			isCurrent: current === tab.view,
			isRouteActive: current === tab.view,
		})),
	)
}

/** Over a draft's editor: nothing is public yet, and Publish page in the header changes that. */
const draftCallout = (h: H): Html =>
	alert(h, { variant: "info", size: "sm", role: "status" }, [
		icon(h, "LockIcon"),
		alertTitle(h, ["This page is a draft"]),
		alertDescription(h, [
			"Visitors can't see it yet. Add your monitors, pick a look in Appearance, then click Publish page.",
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

const body = (h: H, model: Model, page: V2StatusPage, timeZone: string): Html => {
	const view = resolveView(model.search.view)
	switch (view) {
		case "appearance":
			return appearanceView(h, model, page)
		case "settings":
			return settingsView(h, model, page)
		case "live":
			return liveView(h, model, page)
		case "json": {
			const failure = AsyncData.getError(model.config.data)
			if (Option.isSome(failure))
				return errorState(h, {
					failure: failure.value,
					title: "Couldn't load the config",
					onRetry: Message.ClickedRetry(),
					className: "py-12",
				})
			return AsyncData.hasData(model.config.data) ? jsonTab(h, model) : skeleton(h, "h-48 w-full")
		}
		case "page": {
			const read = canvasRead(model)
			if (Option.isSome(read.failure))
				return errorState(h, {
					failure: read.failure.value,
					title: "Couldn't load the page's components",
					onRetry: Message.ClickedRetry(),
					className: "py-12",
				})
			if (!read.isReady)
				return h.div(
					[
						h.Class(
							"grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[22rem_minmax(0,1fr)]",
						),
						h.AriaBusy(true),
					],
					[skeleton(h, "h-48 w-full"), skeleton(h, "h-[560px] w-full")],
				)
			const editor = canvas(h, model, page, { nowMs: model.nowMs ?? 0, timeZone })
			return model.isAdmin && page.draft
				? h.div([h.Class("flex flex-col gap-4")], [draftCallout(h), editor])
				: editor
		}
	}
}

/** What removing it does: a draft has no visitors yet, and only a monitored component has a monitor. */
export const removeComponentCopy = (
	page: V2StatusPage,
	component: Readonly<{ monitor_id: string | null }> | undefined,
): string =>
	[
		page.draft
			? "It leaves the draft; visitors never see it."
			: "Visitors stop seeing it within a minute.",
		...(component?.monitor_id === null || component === undefined ? [] : ["Its monitor keeps running."]),
	].join(" ")

const deleteComponentDialog = (h: H, model: Model, page: V2StatusPage): Html => {
	const component = componentsOf(model).find((row) => row.id === model.confirmDeleteComponentId)
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

const loaded = (h: H, model: Model, page: V2StatusPage, inputs: PageViewInputs): Html => {
	const timeZone = inputs.context.timeZone
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
							h.span(
								[h.Class("flex flex-wrap items-center gap-x-3 gap-y-1")],
								[stateLine(h, model, page, timeZone), addressLine(h, model, page)],
							),
						],
					}),
					actions: headerActions(h, model, page),
					tabs: tabs(h, model, page),
					gap: "md",
				},
				[body(h, model, page, timeZone)],
			),
			deleteComponentDialog(h, model, page),
			breakGlassDialog(h, model),
			deletePageDialog(h, model, page),
		],
	)
}

const notFound = (h: H, model: Model): Html =>
	dashboardPage(h, {}, [
		resourceNotFound(h, {
			title: "Status page not found",
			description: [
				"No status page has the id ",
				h.code([h.Class("font-mono")], [model.rawPageId]),
				".",
			],
			back: { href: statusPagesHref(), label: "Back to status pages" },
		}),
	])

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

/** The H1 names the page; a sub-view adds its name. */
export const breadcrumbsOf = (model: Model) => {
	const page = Option.getOrUndefined(pageOf(model))
	const view = resolveView(model.search.view)
	return [
		{ label: "Status pages", href: statusPagesHref() },
		...(page === undefined
			? []
			: view === "page" || view === "live"
				? [{ label: page.name }]
				: [{ label: page.name, href: statusPageHref(page.id) }, { label: TAB_LABELS[view] }]),
	]
}
