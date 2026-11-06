import type { AlertIncidentDocument } from "@maple/domain/http"
import { formatRelativeShortFrom } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { formatAlertDuration } from "@maple/web-data/alerts/form-utils"
import type { AlertsOverviewReady } from "@maple/web-data/alerts/overview"
import { incidentSubline, incidentTitle } from "@maple/web-data/alerts/overview-derive"
import { Array as Arr, Order } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { filterChip } from "@maple/views/ui/filter-chip"
import { icon } from "@maple/views/ui/icon"
import { removableChip } from "@maple/views/ui/removable-chip"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { stripClass } from "@maple/views/ui/rule"
import { hstack } from "@maple/views/ui/stack"
import { rowLink } from "@maple/views/ui/table"
import { gridListRow } from "../../kit/grid-list-row"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { listToolbar } from "../../kit/list-toolbar"
import { severityBadge } from "../shared/badges"
import { incidentHref } from "../shared/links"
import { isoMs } from "../shared/time"
import { inboxTab, type InboxAcknowledge } from "./view-inbox"
import { Message, type InboxSignal, type IncidentStatusFilter } from "./message"

// The Inbox's signal view: anomaly incidents alone, open, resolved or both (what `/anomalies` was).

type H = HtmlBuilder<Message>

const RESOLVED_LIMIT = 50
const RESOLVED_GRID = "grid grid-cols-[minmax(0,1fr)_110px_90px] items-center gap-4"

const STATUS_OPTIONS: ReadonlyArray<{ value: IncidentStatusFilter; label: string }> = [
	{ value: "open", label: "Open" },
	{ value: "resolved", label: "Resolved" },
	{ value: "all", label: "All" },
]

/** The Inbox's filter row: the Anomalies view toggle and, inside it, the status and service. */
export const inboxFilters = (
	h: H,
	options: Readonly<{
		signal: InboxSignal
		status: IncidentStatusFilter
		serviceName: string | undefined
		openAnomalies: number
	}>,
): Html =>
	listToolbar(h, {
		className: "pb-0",
		leading: hstack(h, { gap: "2", wrap: true }, [
			filterChip(
				h,
				{
					isPressed: options.signal === "anomaly",
					onClick: Message.ClickedInboxSignal({
						signal: options.signal === "anomaly" ? null : "anomaly",
					}),
					count: String(options.openAnomalies),
				},
				["Anomalies"],
			),
			...(options.signal === "anomaly"
				? [
						segmentedSelect(h, {
							options: STATUS_OPTIONS,
							value: options.status,
							onChange: (status) => Message.ClickedIncidentStatus({ status }),
							ariaLabel: "Anomaly status",
							size: "xs",
						}),
						...(options.serviceName === undefined
							? []
							: [
									removableChip(h, {
										label: options.serviceName,
										onRemove: Message.ClickedClearInboxService(),
									}),
								]),
					]
				: []),
		]),
	})

/** Nothing to list: the detector watches every service and opens an anomaly here when it finds one. */
const anomaliesEmpty = (h: H, status: IncidentStatusFilter, serviceName: string | undefined): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "PulseIcon", { size: 16 })]),
				emptyTitle(h, [
					// The hub reads the last 30 days of incidents; older resolved anomalies are not here.
					status === "resolved" ? "No anomalies resolved in the last 30 days" : "No anomalies",
					...(serviceName === undefined ? [] : [` on ${serviceName}`]),
				]),
				emptyDescription(h, [
					`Maple watches error rate, latency, throughput, error spikes and log volume on ${serviceName ?? "every service"}, and opens an anomaly here when one looks unusual against its baseline.`,
				]),
			]),
		],
		"rounded-md border border-dashed py-12",
	)

const byResolvedDesc = Order.flip(
	Order.mapInput(Order.Number, (incident: AlertIncidentDocument) =>
		isoMs(incident.resolvedAt ?? incident.lastTriggeredAt),
	),
)

const resolvedRow = (h: H, incident: AlertIncidentDocument, now: number): Html =>
	gridListRow(h, { key: incident.id, grid: RESOLVED_GRID }, [
		h.div(
			[h.Class("min-w-0 space-y-1")],
			[
				hstack(h, { gap: "2", shrink: true }, [
					severityBadge(h, incident.peakSeverity ?? incident.severity),
					rowLink(
						h,
						{
							href: incidentHref(incident.id),
							className: "min-w-0 truncate font-medium",
							attributes: [h.Title(incidentTitle(incident))],
						},
						[incidentTitle(incident)],
					),
				]),
				typography(h, { size: "xs", tone: "muted", truncate: true, as: "p" }, [
					incidentSubline(incident),
				]),
			],
		),
		typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
			incident.resolvedAt === null
				? ""
				: `${formatRelativeShortFrom(isoMs(incident.resolvedAt), now)} ago`,
		]),
		typography(h, { size: "xs", mono: true, numeric: true }, [
			formatAlertDuration(incident.firstTriggeredAt, incident.resolvedAt),
		]),
	])

const resolvedList = (h: H, incidents: ReadonlyArray<AlertIncidentDocument>, now: number): Html => {
	const shown = Arr.take(Arr.sort(incidents, byResolvedDesc), RESOLVED_LIMIT)
	return h.section(
		[h.Class("space-y-3")],
		[
			eyebrow(h, { as: "h3" }, ["Resolved in the last 30 days"]),
			borderedBox(h, { overflow: "x-auto" }, [
				h.div(
					[h.Class("min-w-[520px]")],
					[
						h.div(
							[
								h.Class(
									cn(
										RESOLVED_GRID,
										typographyClass({
											size: "xs",
											tone: "muted",
											className: stripClass("head"),
										}),
									),
								),
							],
							[
								h.span(
									[],
									[
										"Resolved · ",
										String(incidents.length),
										...(incidents.length > shown.length
											? [`, newest ${shown.length}`]
											: []),
									],
								),
								h.span([], ["Resolved"]),
								h.span([], ["Lasted"]),
							],
						),
						h.ul(
							[h.Class("divide-y")],
							Arr.map(shown, (incident) => resolvedRow(h, incident, now)),
						),
					],
				),
			]),
		],
	)
}

/** The Anomalies view of the Inbox, over the overview narrowed to anomalies. */
export const anomalyInbox = (
	h: H,
	data: AlertsOverviewReady,
	options: Readonly<{
		status: IncidentStatusFilter
		serviceName: string | undefined
		acknowledge: InboxAcknowledge<Message>
	}>,
): Html => {
	const resolved = Arr.filter(data.incidents, (incident) => incident.status === "resolved")
	const now = data.timelineRange.max
	const hasOpenView = options.status !== "resolved"
	const hasResolvedView = options.status !== "open"
	// `incidents` also holds recently resolved ones, so the open side reads `openIncidents`.
	const showOpen = hasOpenView && data.openIncidents.length > 0
	const showResolved = hasResolvedView && resolved.length > 0
	if (!showOpen && !showResolved) return anomaliesEmpty(h, options.status, options.serviceName)
	return h.div(
		[h.Class("space-y-8")],
		[
			...(showOpen ? [inboxTab(h, data, options.acknowledge)] : []),
			...(showResolved ? [resolvedList(h, resolved, now)] : []),
		],
	)
}
