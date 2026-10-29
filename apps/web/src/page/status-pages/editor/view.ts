import type { StatusPageComponentStatus } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { worstStatus } from "@maple/domain/status-page"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../data/load-failure"
import { button, linkButton } from "../../../ui/button"
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
import { statusPageHref, statusPagesHref } from "../shared/commands"
import {
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_TONE,
	componentStatus,
	hasUnpublishedChanges,
} from "../shared/derive"
import { Message } from "./message"
import type { Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf, pageOf } from "./reads"
import { PAGE_MENU_ID, resolveView } from "./update"
import { canvas } from "./view-canvas"
import { jsonTab } from "./view-json"
import { liveView } from "./view-live"
import { breakGlassDialog, deletePageDialog, settingsView } from "./view-settings"

// `/status-pages/$pageId`: the header, then the page as the editor, its Settings, its JSON, or the
// screen right after it went live.

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
		isDisabled: page.draft,
	},
	{ _tag: "Item", value: "settings", label: "Settings", icon: "GearIcon" },
	{ _tag: "Item", value: "json", label: "JSON", icon: "BracketsCurlyIcon" },
	...(model.isAdmin
		? ([
				{ _tag: "Item", value: "break-glass", label: "Break-glass token", icon: "KeyIcon" },
				{ _tag: "Separator" },
				{ _tag: "Item", value: "delete", label: "Delete", icon: "TrashIcon", variant: "destructive" },
			] as const)
		: []),
]

const headerActions = (h: H, model: Model, page: V2StatusPage): Html => {
	const view = resolveView(model.search.view)
	return detailActions(h, [
		...(view === "page"
			? []
			: [
					linkButton(h, { size: "sm", variant: "ghost", href: statusPageHref(page.id) }, [
						icon(h, "ArrowLeftIcon"),
						"Back to page",
					]),
				]),
		...(model.isAdmin && page.draft
			? [
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isLoading: model.isPublishing,
							attributes: [h.OnClick(Message.ClickedPublish())],
						},
						[icon(h, "PaperPlaneIcon"), "Publish"],
					),
				]
			: []),
		...(view === "page"
			? [
					button(
						h,
						{
							size: "sm",
							attributes: [h.OnClick(Message.ClickedNewIncident({ kind: "incident" }))],
						},
						[icon(h, "PlusIcon"), "Post incident"],
					),
				]
			: []),
		rowActionsMenu(h, {
			slotId: PAGE_MENU_ID,
			model: model.pageMenu,
			entries: menuEntries(model, page),
			label: "Page actions",
			toParentMessage: (message) => Message.GotPageMenuMessage({ message }),
		}),
	])
}

/** The reads the page view waits on: statuses need monitors and incidents too. */
const canvasRead = (model: Model): { failure: Option.Option<LoadFailure>; isReady: boolean } => ({
	failure: AsyncData.getError(model.components.data).pipe(
		Option.orElse(() => AsyncData.getError(model.monitors.data)),
		Option.orElse(() => AsyncData.getError(model.incidents.data)),
	),
	isReady:
		AsyncData.hasData(model.components.data) &&
		AsyncData.hasData(model.monitors.data) &&
		AsyncData.hasData(model.incidents.data),
})

const body = (h: H, model: Model, page: V2StatusPage, timeZone: string): Html => {
	const view = resolveView(model.search.view)
	switch (view) {
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
					[h.Class("grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]"), h.AriaBusy(true)],
					[skeleton(h, "h-48 w-full"), skeleton(h, "h-[560px] w-full")],
				)
			return canvas(h, model, page, { nowMs: model.nowMs ?? 0, timeZone })
		}
	}
}

const deleteComponentDialog = (h: H, model: Model): Html => {
	const name = componentsOf(model).find(
		(component) => component.id === model.confirmDeleteComponentId,
	)?.name
	return confirmDialog(h, {
		slotId: "status-page-delete-component",
		model: model.deleteComponentDialog,
		toParentMessage: (message) => Message.GotDeleteComponentDialogMessage({ message }),
		title: `Remove ${name ?? "this component"} from the page?`,
		description: "Visitors stop seeing it with the next publish. Its monitor keeps running.",
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
						meta: [stateLine(h, model, page, timeZone)],
					}),
					actions: headerActions(h, model, page),
					gap: "md",
				},
				[body(h, model, page, timeZone)],
			),
			deleteComponentDialog(h, model),
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
			: view === "settings" || view === "json"
				? [
						{ label: page.name, href: statusPageHref(page.id) },
						{ label: view === "settings" ? "Settings" : "JSON" },
					]
				: [{ label: page.name }]),
	]
}
