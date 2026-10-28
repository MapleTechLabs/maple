import type { StatusPageComponentStatus } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { worstStatus } from "@maple/domain/status-page"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import type { LoadFailure } from "../../../../data/load-failure"
import { badge } from "../../../../ui/display"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { skeleton } from "../../../../ui/skeleton"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { detailActions, detailTitle, detailTitleSkeleton } from "../../../kit/detail-header"
import { relativeTime } from "../../../kit/relative-time"
import { resourceNotFound } from "../../../kit/resource-not-found"
import { underlineTabClass, underlineTabStrip } from "../../../kit/underline-tabs"
import {
	type EditorTab,
	publicPath,
	statusPageHref,
	statusPagesTabHref,
} from "../../shared/status-page-commands"
import {
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_TONE,
	componentStatus,
	hasUnpublishedChanges,
	isOpenIncident,
} from "../../shared/status-page-derive"
import { Message } from "./message"
import type { Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf, pageOf } from "./reads"
import { resolveTab } from "./update"
import { componentDialog, componentsTab, deleteComponentDialog } from "./view-components"
import { incidentDialog, incidentsTab, updateDialog } from "./view-incidents"
import { breakGlassDialog, deletePageDialog, settingsTab } from "./view-settings"

// `/alerts/status-pages/$pageId`: the header, the tabs, and the dialogs every tab opens.

type H = HtmlBuilder<Message>

const TABS: ReadonlyArray<{ value: EditorTab; label: string }> = [
	{ value: "components", label: "Components" },
	{ value: "incidents", label: "Incidents" },
	{ value: "settings", label: "Settings" },
]

const tabBar = (h: H, page: V2StatusPage, active: EditorTab, openIncidents: number): Html =>
	underlineTabStrip(
		h,
		{ label: "Status page sections", navigation: true },
		TABS.map((tab) =>
			h.a(
				[
					h.Key(tab.value),
					h.Href(statusPageHref(page.id, tab.value)),
					...(tab.value === active ? [h.AriaCurrent("page")] : []),
					h.Class(underlineTabClass(tab.value === active)),
				],
				[
					tab.label,
					...(tab.value === "incidents" && openIncidents > 0
						? [
								h.span(
									[h.Class("font-mono text-xs tabular-nums text-severity-warn")],
									[String(openIncidents)],
								),
							]
						: []),
				],
			),
		),
	)

/** The banner a visitor sees now: the worst component, from what is loaded. */
const overallOf = (model: Model): StatusPageComponentStatus =>
	worstStatus(
		componentsOf(model).map((component) =>
			componentStatus(component, monitorsOf(model), incidentsOf(model)),
		),
	)

/** When visitors last got the page, or why they did not. */
const publishLine = (h: H, model: Model, page: V2StatusPage, timeZone: string): Html => {
	const className = "text-xs text-muted-foreground"
	if (page.last_publish_error !== null)
		return h.span(
			[h.Class("text-xs text-destructive")],
			[`Last publish failed: ${page.last_publish_error}`],
		)
	if (page.published_at === null) return h.span([h.Class(className)], ["Not published yet"])
	return h.span(
		[h.Class(className)],
		[
			relativeTime(h, {
				value: page.published_at,
				nowMs: model.nowMs ?? 0,
				timeZone,
				tooltip: "title",
				prefix: "Published",
			}),
			...(hasUnpublishedChanges(page) ? [" · changes go out within a minute"] : []),
		],
	)
}

const headerActions = (h: H, model: Model): Html =>
	detailActions(h, [
		...(model.isAdmin
			? [
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isLoading: model.isPublishing,
							attributes: [h.OnClick(Message.ClickedPublish())],
						},
						[icon(h, "PaperPlaneIcon"), "Publish now"],
					),
				]
			: []),
	])

/** The read a tab waits on: its failure, and whether its data is in. */
const tabRead = (model: Model, tab: EditorTab): { failure: Option.Option<LoadFailure>; isReady: boolean } => {
	switch (tab) {
		case "settings":
			return { failure: Option.none(), isReady: true }
		case "incidents":
			return {
				failure: AsyncData.getError(model.incidents.data),
				isReady: AsyncData.hasData(model.incidents.data),
			}
		case "components":
			return {
				failure: AsyncData.getError(model.components.data),
				isReady: AsyncData.hasData(model.components.data),
			}
	}
}

const tabBody = (h: H, model: Model, page: V2StatusPage, tab: EditorTab, timeZone: string): Html => {
	const read = tabRead(model, tab)
	if (Option.isSome(read.failure))
		return errorState(h, {
			failure: read.failure.value,
			title: tab === "incidents" ? "Couldn't load incidents" : "Couldn't load components",
			onRetry: Message.ClickedRetry(),
			className: "py-12",
		})
	if (!read.isReady) return skeleton(h, "h-48 w-full")
	switch (tab) {
		case "components":
			return componentsTab(h, model)
		case "incidents":
			return incidentsTab(h, model, { nowMs: model.nowMs ?? 0, timeZone })
		case "settings":
			return settingsTab(h, model, page)
	}
}

const loaded = (h: H, model: Model, page: V2StatusPage, inputs: PageViewInputs): Html => {
	const tab = resolveTab(model.search.tab)
	const timeZone = inputs.context.timeZone
	const overall = overallOf(model)
	const hasComponents = AsyncData.hasData(model.components.data) && componentsOf(model).length > 0
	return h.div(
		[h.Class("contents")],
		[
			dashboardPage(
				h,
				{
					titleContent: detailTitle(h, {
						kind: ["Status page", publicPath(page.slug)],
						title: [page.name],
						adornment: hasComponents
							? badge(h, { variant: COMPONENT_STATUS_TONE[overall] }, [
									COMPONENT_STATUS_LABEL[overall],
								])
							: h.empty,
						meta: [publishLine(h, model, page, timeZone)],
					}),
					actions: headerActions(h, model),
					tabs: tabBar(h, page, tab, incidentsOf(model).filter(isOpenIncident).length),
					gap: "md",
				},
				[tabBody(h, model, page, tab, timeZone)],
			),
			componentDialog(h, model),
			deleteComponentDialog(h, model),
			incidentDialog(h, model, timeZone),
			updateDialog(h, model),
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
			back: { href: statusPagesTabHref(), label: "Back to status pages" },
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

/** The H1 names the page, so the trail stops at the tab. */
export const breadcrumbsOf = () => [
	{ label: "Alerts", href: "/alerts" },
	{ label: "Status pages", href: statusPagesTabHref() },
]
