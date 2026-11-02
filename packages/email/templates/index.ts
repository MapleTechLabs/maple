/**
 * The three emails. Each is a page, with `[[token]]` values and `[[#slot]]`
 * holes, plus the fragments the runtime splices into those holes. Fragment
 * names are what `src/*.ts` looks up in the generated `FRAGMENTS`.
 */
import type { Html } from "foldkit/html"
import * as C from "./components"
import { cellsSlot, type Child, type Context, type H, rowsSlot, type Unit } from "./render"

export interface Template {
	/** Generated module under `src/generated/`. */
	readonly output: string
	readonly page: (h: H) => ReadonlyArray<Child>
	readonly fragments: Readonly<Record<string, Unit>>
}

const single =
	(context: Context) =>
	(view: (h: H) => Html): Unit => ({ context, view: (h) => [view(h)] })

/** Root `<tr>`s render inside a tbody, root `<td>`s inside a row. */
const row = single("tbody")
const cell = single("tr")
const flow = single("flow")
/** A fragment that is a run of sibling blocks rather than one element. */
const flowRun = (view: (h: H) => ReadonlyArray<Child>): Unit => ({ context: "flow", view })

const weeklyDigest: Template = {
	output: "weekly-digest.ts",
	page: (h) =>
		C.shell(h, [
			C.header(h, "[[orgName]]", ["Weekly digest · [[dateStart]] – [[dateEnd]][[#scopeLine]]"]),
			C.divider(h),
			"[[#statusBanner]]",
			"[[#sparklineSection]]",
			C.summaryGrid(h),
			"[[#breakdownSections]]",
			"[[#servicesSection]]",
			"[[#errorsSection]]",
			C.section(h, "px-6 pt-5", [
				C.sectionLabel(h, ["[[ingestionHeading]]"], "mb-3"),
				h.table(
					[h.Class("w-full border-collapse")],
					[h.tbody([], [h.tr([], [cellsSlot(h, "ingestionCells")])])],
				),
			]),
			C.section(h, "px-6 pb-2 pt-6", [C.cta(h, "[[dashboardUrl]]", "Open dashboard →")]),
			C.digestFooter(h, "You subscribed to weekly digests."),
		]),
	fragments: {
		affectedServices: flow(C.affectedServices),
		breakdownRow: row(C.breakdownRow),
		breakdownTable: flow(C.breakdownTable),
		barErr: flow(C.barErr),
		barOk: flow(C.barOk),
		biggestMover: flow(C.biggestMover),
		deltaPill: flow(C.deltaPill),
		envGroupHeader: row(C.envGroupHeader),
		errorRow: flow(C.errorRow),
		errorsSection: flow(C.errorsSection),
		ingestionCell: cell(C.ingestionCell),
		ingestionDelta: flow(C.ingestionDelta),
		newBadge: flow(C.newBadge),
		scopeChip: flow(C.scopeChip),
		scopeLine: flow(C.scopeLine),
		serviceRequestsDelta: flow(C.serviceDelta),
		serviceRow: row(C.serviceRow),
		servicesSection: flow(C.servicesSection),
		sparkBar: cell(C.sparkBar),
		sparkLabel: cell(C.sparkLabel),
		sparklineSection: flow(C.sparklineSection),
		statusBanner: flow(C.statusBanner),
		summaryCard: cell(C.summaryCard),
	},
}

const webAnalyticsDigest: Template = {
	output: "web-analytics-digest.ts",
	page: (h) =>
		C.shell(h, [
			C.header(h, "[[orgName]]", ["Web analytics · [[dateStart]] – [[dateEnd]]"]),
			C.divider(h),
			"[[#highlightBanner]]",
			C.summaryGrid(h),
			"[[#pagesSection]]",
			"[[#sourcesSection]]",
			"[[#aiSection]]",
			C.section(h, "px-6 pb-2 pt-6", [C.cta(h, "[[analyticsUrl]]", "Open web analytics →")]),
			C.digestFooter(h, "You get this because your team uses Maple web analytics."),
		]),
	fragments: {
		aiColumn: cell(C.aiColumn),
		aiSection: flowRun(C.aiSection),
		biggestMover: flow(C.biggestMover),
		compactRow: row(C.compactRow),
		deltaPill: flow(C.deltaPill),
		highlightBanner: flow(C.statusBanner),
		quietLine: flow(C.quietLine),
		rankRow: row(C.rankRow),
		rankTable: flow(C.rankTable),
		rowIcon: cell(C.rowIcon),
		sectionHead: flowRun(C.sectionHead),
		statCard: cell(C.statCard),
	},
}

const alertNotification: Template = {
	output: "alert-notification.ts",
	page: (h) =>
		C.shell(h, [
			C.header(h, "Maple Alerts", ["Alert notification"]),
			C.divider(h, "[[accentColor]]"),
			C.section(h, "px-5 pt-5", [
				h.div(
					[
						h.Attribute(
							"style",
							"border-left:3px solid [[accentColor]];background-color:#262320;border-top-right-radius:8px;border-bottom-right-radius:8px;padding:14px 16px",
						),
					],
					[
						h.span(
							[
								h.Attribute(
									"style",
									"display:inline-block;background-color:[[accentColor]];color:#ffffff;border-radius:5px;padding:3px 8px;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase",
								),
							],
							["[[eventLabel]]"],
						),
						h.p(
							[
								h.Class(
									"m-0 mt-2.5 font-mono text-[15px] font-semibold leading-snug text-maple-fg",
								),
							],
							["[[eventEmoji]] [[ruleName]]"],
						),
						h.p(
							[h.Class("m-0 mt-1 font-mono text-[12px] leading-snug text-maple-fg-muted")],
							["[[observedSummary]]"],
						),
					],
				),
			]),
			C.section(h, "px-6 pt-5", [
				C.panel(h, [
					h.table([h.Class("w-full border-collapse")], [h.tbody([], [rowsSlot(h, "detailRows")])]),
				]),
			]),
			C.section(h, "px-6 pb-2 pt-6", [C.cta(h, "[[linkUrl]]", "Open in Maple →")]),
			C.footer(h, [
				"🍁 Maple Alerts · You are receiving this because this address is an alert destination for your organization.",
			]),
		]),
	fragments: { detailRow: row(C.detailRow) },
}

export const TEMPLATES: ReadonlyArray<Template> = [weeklyDigest, webAnalyticsDigest, alertNotification]
