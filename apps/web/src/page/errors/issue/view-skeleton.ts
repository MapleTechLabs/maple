import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { detailRailGroup, detailRailRow } from "../../../ui/detail-rail"
import { panel } from "../../../ui/panel"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import { tabOf, windowLabel } from "./derive"
import type { Message } from "./message"
import type { Model } from "./model"
import { headerActions, issueTabs } from "./view-header"
import { factLane, factStrip, issueField } from "./view-overview"

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

const overviewSkeleton = (h: H, label: string): Html =>
	h.div(
		[h.Class("flex flex-col gap-7")],
		[
			h.div(
				[h.Class("flex shrink-0 overflow-hidden rounded-r-xl border bg-card")],
				[
					h.span([h.AriaHidden(true), h.Class("w-[3px] shrink-0 bg-border")], []),
					h.div(
						[h.Class("flex min-w-0 flex-1 flex-col gap-4 px-6 py-5")],
						[
							h.div(
								[h.Class("flex flex-col gap-2")],
								[skeleton(h, "h-4 w-full"), skeleton(h, "h-4 w-3/5")],
							),
							issueField(h, "Culprit", [skeleton(h, "h-4 w-[min(24rem,70%)]")]),
							issueField(h, "Fingerprint", [skeleton(h, "h-4 w-48")]),
						],
					),
				],
			),
			factStrip(h, [
				factLane(h, `Events · ${label}`, [skeleton(h, "h-4 w-12")]),
				factLane(h, "Events · all time", [skeleton(h, "h-4 w-14")]),
				factLane(h, "First seen", [skeleton(h, "h-4 w-24")]),
				factLane(h, "Last seen", [skeleton(h, "h-4 w-20")]),
			]),
			panel(h, { className: "shrink-0 gap-3.5 px-5 py-4" }, [
				h.div(
					[h.Class("flex items-baseline gap-2.5")],
					[
						h.h2([h.Class("text-sm font-medium text-foreground")], ["Occurrences"]),
						skeleton(h, "h-3 w-28"),
					],
				),
				skeleton(h, "h-44 w-full rounded-md"),
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
		[h.Class("flex flex-col bg-card/30")],
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
			actions: headerActions(h, model, null, null),
			tabs: issueTabs(h, model.issueId, model.search, { active: tab, showOccurrences: true }),
			rightPanel: railSkeleton(h),
		},
		[tab === "overview" ? overviewSkeleton(h, windowLabel(model.search)) : listSkeleton(h)],
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
