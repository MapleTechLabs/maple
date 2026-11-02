import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { detailRailGroup, detailRailRow } from "../../../ui/detail-rail"
import { panel, panelHeader } from "../../../ui/panel"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import { tabOf } from "./derive"
import type { Message } from "./message"
import type { Model } from "./model"
import { headerActions, issueTabs } from "./view-header"
import { statRailLoading } from "../../kit/stat-rail"
import { issueField } from "./view-overview"

// The issue detail skeleton and the not-found state.

type H = HtmlBuilder<Message>

const titleSkeleton = (h: H): Html =>
	h.div(
		[h.Class("min-w-0 space-y-2.5")],
		[
			skeleton(h, "h-3 w-32"),
			skeleton(h, "h-7 w-[min(28rem,80%)]"),
			h.div(
				[h.Class("flex items-center gap-2")],
				[skeleton(h, "h-5 w-16 rounded-full"), skeleton(h, "h-5 w-24 rounded-full")],
			),
		],
	)

const overviewSkeleton = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-4")],
		[
			panel(h, { className: "shrink-0 overflow-hidden" }, [
				panelHeader(h, { title: "What broke" }),
				h.div(
					[h.Class("flex flex-col gap-4 p-4")],
					[
						h.div(
							[h.Class("flex flex-col gap-2")],
							[skeleton(h, "h-4 w-full"), skeleton(h, "h-4 w-3/5")],
						),
						issueField(h, "Raised at", [skeleton(h, "h-4 w-[min(24rem,70%)]")]),
					],
				),
			]),
			statRailLoading(h, 4, 4, "shrink-0"),
			panel(h, { className: "shrink-0 overflow-hidden" }, [
				panelHeader(h, { title: "Get it fixed" }),
				h.div(
					[h.Class("grid divide-y xl:grid-cols-2 xl:divide-x xl:divide-y-0")],
					[0, 1].map((lane) =>
						h.div(
							[h.Key(String(lane)), h.Class("flex flex-col gap-3 p-4")],
							[
								skeleton(h, "h-3 w-28"),
								skeleton(h, "h-4 w-3/4"),
								skeleton(h, "h-10 w-full"),
								skeleton(h, "h-7 w-32"),
							],
						),
					),
				),
				h.div([h.Class("border-t px-4 py-2.5")], [skeleton(h, "h-3 w-28")]),
			]),
			panel(h, { className: "shrink-0 overflow-hidden" }, [
				panelHeader(h, { title: "Occurrences", scope: skeleton(h, "h-3 w-28") }),
				h.div([h.Class("px-4 pt-3 pb-4")], [skeleton(h, "h-44 w-full rounded-md")]),
			]),
		],
	)

const listSkeleton = (h: H): Html =>
	h.section(
		[h.Class("flex shrink-0 flex-col gap-3.5")],
		[
			skeleton(h, "h-5 w-40"),
			skeletonList(h, { rows: 6, rowClassName: "h-11 rounded-lg", className: "gap-2.5" }),
		],
	)

const railRow = (h: H, label: string, width: string): Html =>
	detailRailRow(h, { label }, [skeleton(h, `h-4 ${width}`)])

const railSkeleton = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col")],
		[
			detailRailGroup(h, "Details", [
				railRow(h, "Status", "w-24"),
				railRow(h, "Severity", "w-16"),
				railRow(h, "Priority", "w-20"),
				railRow(h, "Assignee", "w-24"),
			]),
			detailRailGroup(h, "Scope", [
				railRow(h, "Service", "w-28"),
				railRow(h, "Environment", "w-20"),
				railRow(h, "Issue ID", "w-16"),
			]),
		],
	)

/** The page's frame while the issue loads: real labels, tabs and controls; skeleton values. */
export const issueSkeleton = (h: H, model: Model): Html => {
	const tab = tabOf(model.search)
	return dashboardPage(
		h,
		{
			titleContent: titleSkeleton(h),
			actions: headerActions(h, model, null),
			tabs: issueTabs(h, model.issueId, model.search, { active: tab, showOccurrences: true }),
			rightPanel: railSkeleton(h),
		},
		[tab === "overview" ? overviewSkeleton(h) : listSkeleton(h)],
	)
}

/** `ResourceNotFound` with its way back to the list. */
export const issueNotFound = (h: H): Html =>
	dashboardPage(h, {}, [
		resourceNotFound(h, {
			title: "Issue not found",
			back: { href: hrefOf(AppRoute.Errors({ search: {} })), label: "Back to errors" },
		}),
	])
