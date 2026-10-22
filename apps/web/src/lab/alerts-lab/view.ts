import type { AlertsLabFixture } from "../alerts-fixture"
import type { AlertsOverviewReady } from "@maple/web-data/alerts/overview"
import { cn } from "@maple/ui/lib/utils"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alertsEmptyState } from "../../page/alerts/hub/view-empty"
import { inboxTab } from "../../page/alerts/hub/view-inbox"
import { DESTINATION_ROW_GRID, destinationRow, HEALTH_WINDOW } from "../../page/alerts/hub/view-routing"
import { rulesTab } from "../../page/alerts/hub/view-rules"
import type { Message as HubMessage } from "../../page/alerts/hub/message"
import type { Model as HubModel } from "../../page/alerts/hub/model"
import { underlineTabClass, underlineTabStrip } from "../../page/kit/underline-tabs"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import type { Model } from "./model"

type AlertsTab = "inbox" | "rules" | "routing"

export const FRAME_WIDTH = "1200px"
const ALERTS_TABS: ReadonlyArray<{ value: AlertsTab; label: string }> = [
	{ value: "inbox", label: "Inbox" },
	{ value: "rules", label: "Rules" },
	{ value: "routing", label: "Routing" },
]

/** `LabSection`. */
export const section = <M>(
	h: HtmlBuilder<M>,
	id: string,
	title: string,
	children: ReadonlyArray<Html>,
): Html =>
	h.section(
		[h.Id(id), h.Class("scroll-mt-6 space-y-3")],
		[
			h.h2(
				[h.Class("font-mono text-xs text-muted-foreground")],
				["#", id, " ", h.span([h.Class("text-foreground")], [title])],
			),
			...children,
		],
	)

/** `AlertsFrame`: the `/alerts` header and tab strip around one tab's body, at a desktop width. */
const alertsFrame = <M>(h: HtmlBuilder<M>, tab: AlertsTab, data: AlertsOverviewReady, child: Html): Html => {
	const counts = new Map<AlertsTab, number>([
		["inbox", data.openIncidents.length],
		["rules", data.rules.length],
		["routing", 0],
	])
	return h.div(
		[h.Class("overflow-hidden rounded-md border bg-background"), h.Style({ width: FRAME_WIDTH })],
		[
			h.div(
				[h.Class("space-y-3 border-b px-4 pt-4")],
				[
					h.div(
						[h.Class("flex items-center justify-between gap-4")],
						[
							h.p([h.Class("text-sm font-medium")], ["Alerts"]),
							button(h, { size: "sm" }, [
								icon(h, "PlusIcon"),
								tab === "routing" ? "Add destination" : "New rule",
							]),
						],
					),
					underlineTabStrip(
						h,
						{ label: "Alerts sections", bleed: false, divided: false },
						ALERTS_TABS.map((entry) => {
							const count = counts.get(entry.value) ?? 0
							return h.span(
								[h.Class(underlineTabClass(entry.value === tab))],
								[
									entry.label,
									...(count > 0
										? [
												h.span(
													[
														h.Class(
															cn(
																"font-mono text-xs tabular-nums",
																entry.value === "inbox"
																	? "text-severity-error"
																	: "text-muted-foreground",
															),
														),
													],
													[String(count)],
												),
											]
										: []),
								],
							)
						}),
					),
				],
			),
			h.div([h.Class("p-6")], [child]),
		],
	)
}

type HubInputs = Readonly<{
	fixture: AlertsLabFixture
	status: Model["status"]
	timeZone: string
	nowMs: number
}>

/** The sections the hub's views draw, run against the lab's hub Model. */
export const hubSections = Submodel.defineView<HubModel, HubMessage, HubInputs>((hub, inputs, h) => {
	const { fixture } = inputs
	const routing = { destinations: fixture.destinations, timeZone: inputs.timeZone, nowMs: inputs.nowMs }
	return h.div(
		[h.Class("space-y-12")],
		[
			section(h, "inbox", "Inbox: two firing, one held", [
				alertsFrame(h, "inbox", fixture.overview, inboxTab(h, fixture.overview)),
			]),
			section(h, "inbox-quiet", "Inbox: nothing firing, two blind spots", [
				alertsFrame(h, "inbox", fixture.quiet, inboxTab(h, fixture.quiet)),
			]),
			section(h, "rules", "Rules", [
				alertsFrame(
					h,
					"rules",
					fixture.overview,
					rulesTab(h, hub, {
						data: fixture.overview,
						destinations: fixture.destinations,
						status: inputs.status ?? undefined,
						emptyState: alertsEmptyState(h, {
							isAdmin: true,
							hasDestinations: true,
							serviceName: undefined,
							onAddDestination: undefined,
						}),
					}),
				),
			]),
			section(h, "routing", "Routing: destinations and delivery health", [
				alertsFrame(
					h,
					"routing",
					fixture.overview,
					h.div(
						[h.Class("overflow-x-auto rounded-md border")],
						[
							h.div(
								[h.Class("min-w-[760px]")],
								[
									h.div(
										[
											h.Class(
												cn(
													DESTINATION_ROW_GRID,
													"border-b px-4 py-2 text-xs text-muted-foreground",
												),
											),
										],
										[
											h.span([], ["Destination"]),
											h.span([], ["Type"]),
											h.span([], ["Last ", String(HEALTH_WINDOW), " attempts"]),
											h.span([h.Class("text-right")], ["Last delivered"]),
											h.span([], []),
										],
									),
									h.ul(
										[h.Class("divide-y")],
										fixture.destinations.map((destination) =>
											destinationRow(h, hub, routing, {
												destination,
												recent: fixture.deliveries
													.filter((event) => event.destinationId === destination.id)
													.slice(0, HEALTH_WINDOW),
											}),
										),
									),
								],
							),
						],
					),
				),
			]),
		],
	)
})
