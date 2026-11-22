import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { detailRailGroup, detailRailRow } from "@maple/views/ui/detail-rail"
import { panel, panelHeader, panelChartBody } from "@maple/views/ui/panel"
import { skeleton, skeletonBlock, skeletonList } from "@maple/views/ui/skeleton"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import { tabOf } from "./derive"
import type { Message } from "./message"
import type { Model } from "./model"
import { headerActions, issueTabs } from "./view-header"
import { statRail, statRailItemSkeleton } from "../../kit/stat-rail"
import { issueField } from "./view-overview"
import { hstack, vstack } from "@maple/views/ui/stack"
import { strip, stripClass } from "@maple/views/ui/rule"
import { Array as Arr } from "effect"

type H = HtmlBuilder<Message>

const titleSkeleton = (h: H): Html =>
	h.div(
		[h.Class("min-w-0 space-y-2.5")],
		[
			skeleton(h, "h-3 w-32"),
			skeleton(h, "h-7 w-[min(28rem,80%)]"),
			hstack(h, { gap: "2" }, [
				skeleton(h, "h-5 w-16 rounded-full"),
				skeleton(h, "h-5 w-24 rounded-full"),
			]),
		],
	)

const overviewSkeleton = (h: H): Html =>
	vstack(h, { gap: "4" }, [
		panel(h, { className: "shrink-0 overflow-hidden" }, [
			panelHeader(h, { title: "What broke" }),
			vstack(h, { gap: "4", className: "p-4" }, [
				vstack(h, { gap: "2" }, [skeleton(h, "h-4 w-full"), skeleton(h, "h-4 w-3/5")]),
				issueField(h, "Raised at", [skeleton(h, "h-4 w-[min(24rem,70%)]")]),
			]),
		]),
		panel(h, { className: "shrink-0 overflow-hidden" }, [
			statRail(
				h,
				{ columns: 4, isFlush: true, isBusy: true },
				Arr.map([0, 1, 2, 3], () => statRailItemSkeleton(h)),
			),
			panelChartBody(h, [skeleton(h, "mb-2 h-3 w-28"), skeletonBlock(h, { height: "44" })]),
		]),
		panel(h, { className: "shrink-0 overflow-hidden" }, [
			h.div(
				[],
				Arr.map([0, 1], (lane) =>
					hstack(
						h,
						{
							gap: "3",
							justify: "between",
							className: stripClass("row", "py-3"),
							attributes: [h.Key(String(lane))],
						},
						[
							hstack(h, { gap: "3", className: "min-w-0 flex-1" }, [
								skeleton(h, "size-8 rounded-md"),
								vstack(h, { gap: "1.5", className: "min-w-0 flex-1" }, [
									skeleton(h, "h-4 w-48"),
									skeleton(h, "h-3 w-3/4"),
								]),
							]),
							skeleton(h, "h-7 w-32"),
						],
					),
				),
			),
			strip(h, { kind: "foot" }, [skeleton(h, "h-3 w-28")]),
		]),
	])

const listSkeleton = (h: H): Html =>
	vstack(h, { as: "section", className: "shrink-0 gap-3.5" }, [
		skeleton(h, "h-5 w-40"),
		skeletonList(h, { rows: 6, rowClassName: "h-11 rounded-lg", className: "gap-2.5" }),
	])

const railRow = (h: H, label: string, width: string): Html =>
	detailRailRow(h, { label }, [skeleton(h, `h-4 ${width}`)])

const railSkeleton = (h: H): Html =>
	vstack(h, {}, [
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
	])

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

export const issueNotFound = (h: H): Html =>
	dashboardPage(h, {}, [
		resourceNotFound(h, {
			title: "Issue not found",
			back: { href: hrefOf(AppRoute.Errors({ search: {} })), label: "Back to errors" },
		}),
	])
