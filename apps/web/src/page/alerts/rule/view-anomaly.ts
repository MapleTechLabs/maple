import type { AlertDestinationDocument, AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { ANOMALY_SIGNAL_LABELS } from "@maple/web-data/alerts/anomaly-rule"
import { formatAlertDuration } from "@maple/web-data/alerts/form-utils"
import { incidentTitle } from "@maple/web-data/alerts/overview-derive"
import { formatDateInTimezone, formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { card, cardPanel } from "@maple/views/ui/card"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { dividedList } from "@maple/views/ui/rule"
import { hstack } from "@maple/views/ui/stack"
import { rowLink } from "@maple/views/ui/table"
import { typography } from "@maple/views/ui/typography"
import { sectionHeading } from "../../kit/section-heading"
import { alertStatusBadge, severityBadge } from "../shared/badges"
import { incidentHref } from "../shared/links"
import { isoMs } from "../shared/time"

// An anomaly rule's Overview: the anomalies it paged on in the window, and its scope and routing.
// It has no query to replay and no threshold, window or sample count of its own.

const INCIDENT_LIMIT = 20

const overlaps = (incident: AlertIncidentDocument, range: Readonly<{ min: number; max: number }>): boolean =>
	isoMs(incident.firstTriggeredAt) <= range.max &&
	(incident.resolvedAt === null || isoMs(incident.resolvedAt) >= range.min)

/** The rule's anomaly incidents that were open at some point in the window, newest first. */
export const anomalyIncidentsSection = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		incidents: ReadonlyArray<AlertIncidentDocument>
		range: Readonly<{ min: number; max: number }>
		rangeLabel: string
		now: number
		timeZone: string
	}>,
): Html => {
	const inWindow = Arr.take(
		Arr.filter(options.incidents, (incident) => overlaps(incident, options.range)),
		INCIDENT_LIMIT,
	)
	const at = (iso: string) =>
		`${formatDateInTimezone(iso, { timeZone: options.timeZone })} ${formatTimeInTimezone(iso, { timeZone: options.timeZone })}`
	return h.section(
		[h.Class("space-y-3")],
		[
			h.div(
				[h.Class("space-y-1")],
				[
					eyebrow(h, { as: "h2", className: "mb-0 block" }, [`Anomalies: ${options.rangeLabel}`]),
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"What Maple's anomaly detector found in this rule's scope. The detector decides; this rule only routes.",
					]),
				],
			),
			inWindow.length === 0
				? typography(h, { size: "sm", tone: "muted", as: "p" }, ["No anomalies in this window."])
				: dividedList(
						h,
						{ as: "ul" },
						Arr.map(inWindow, (incident) =>
							h.li(
								[
									h.Key(incident.id),
									h.Class("relative flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"),
								],
								[
									severityBadge(h, incident.peakSeverity ?? incident.severity),
									rowLink(
										h,
										{
											href: incidentHref(incident.id),
											className: "min-w-0 flex-1 truncate font-medium",
										},
										[incidentTitle(incident)],
									),
									typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [
										incident.status === "open"
											? `open since ${at(incident.firstTriggeredAt)}`
											: `${at(incident.firstTriggeredAt)} · lasted ${formatAlertDuration(incident.firstTriggeredAt, incident.resolvedAt)}`,
									]),
								],
							),
						),
					),
		],
	)
}

const valueList = <M>(h: HtmlBuilder<M>, values: ReadonlyArray<string>, all: string): Html =>
	values.length === 0
		? typography(h, { weight: "medium", mono: true }, [all])
		: h.div(
				[h.Class("flex flex-wrap justify-end gap-1")],
				Arr.map(values, (value) => badge(h, { variant: "outline", className: "text-xs" }, [value])),
			)

const tierDestinations = <M>(
	h: HtmlBuilder<M>,
	ids: ReadonlyArray<string>,
	destinations: ReadonlyArray<AlertDestinationDocument>,
): Html => {
	const byId = new Map<string, string>(
		Arr.map(destinations, (destination) => [destination.id, destination.name]),
	)
	const names = Arr.flatMap(ids, (id): ReadonlyArray<string> => {
		const name = byId.get(id)
		return name === undefined ? [] : [name]
	})
	return names.length === 0 ? typography(h, { tone: "muted" }, ["Nobody"]) : valueList(h, names, "")
}

const row = <M>(h: HtmlBuilder<M>, label: string, children: ReadonlyArray<Html | string>): Html =>
	keyValue(h, { label, wrap: true, className: "items-center" }, children)

/** An anomaly rule's configuration: its scope, each tier's destinations and its cadence. */
export const anomalyConfiguration = <M>(
	h: HtmlBuilder<M>,
	rule: AlertRuleDocument,
	destinations: ReadonlyArray<AlertDestinationDocument>,
): Html => {
	const tier = (severity: "warning" | "critical"): ReadonlyArray<string> =>
		Arr.flatMap(rule.thresholds, (threshold): ReadonlyArray<string> =>
			threshold.severity === severity ? threshold.destinationIds : [],
		)
	return h.div(
		[h.Class("space-y-3")],
		[
			sectionHeading(h, { title: "Configuration" }),
			card(h, [
				cardPanel(
					h,
					[
						keyValueList(
							h,
							{ className: "grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2" },
							[
								...(rule.notes
									? [
											row(h, "Notes", [
												h.span([h.Class("whitespace-pre-wrap")], [rule.notes]),
											]),
										]
									: []),
								row(h, "Signal", [typography(h, { weight: "medium" }, ["Anomaly"])]),
								row(h, "Services", [valueList(h, rule.serviceNames, "all")]),
								row(h, "Environments", [valueList(h, rule.environments, "all")]),
								row(h, "Signals", [
									valueList(
										h,
										Arr.map(
											rule.anomalySignals ?? [],
											(signal) => ANOMALY_SIGNAL_LABELS[signal],
										),
										"all",
									),
								]),
								row(h, "Warning", [tierDestinations(h, tier("warning"), destinations)]),
								row(h, "Critical", [tierDestinations(h, tier("critical"), destinations)]),
								row(h, "Checked", [typography(h, { weight: "medium" }, ["every 1m"])]),
								row(h, "Status", [
									hstack(h, { gap: "2", justify: "end" }, [
										alertStatusBadge(h, rule.enabled ? "ok" : "disabled", {
											label: rule.enabled ? "Enabled" : "Disabled",
										}),
									]),
								]),
							],
						),
					],
					"p-5",
				),
			]),
		],
	)
}
