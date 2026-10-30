import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { SEVERITY_TONE } from "@maple/web-data/anomalies/format"
import { anomalyIncidentFromV2 } from "../../../lib/services/anomalies"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { statusDot } from "../../../ui/status-dot"
import { anomalyRow } from "../../anomalies/kit/row"
import { sectionHeading } from "../../kit/section-heading"
import type { Model } from "./model"

// The related anomalies section and the open anomaly badge.

export const relatedAnomaliesOf = (model: Model): ReadonlyArray<AnomalyIncidentDocument> =>
	Option.match(AsyncData.getData(model.anomalies.data), {
		onNone: () => [],
		onSome: (incidents) => incidents.map(anomalyIncidentFromV2),
	})

/** Nothing at all (header included) when no detector incident points here. */
export const relatedAnomaliesSection = <M>(
	h: HtmlBuilder<M>,
	incidents: ReadonlyArray<AnomalyIncidentDocument>,
	options: Readonly<{ nowMs: number; timeZone: string }>,
): ReadonlyArray<Html> => {
	if (incidents.length === 0) return []
	const sorted = [...incidents].sort((a, b) => {
		if ((a.status === "open") !== (b.status === "open")) return a.status === "open" ? -1 : 1
		return b.lastTriggeredAt.localeCompare(a.lastTriggeredAt)
	})
	return [
		h.section(
			[h.AriaLabelledBy("related-anomalies-heading"), h.Class("flex shrink-0 flex-col gap-3.5")],
			[
				sectionHeading(h, {
					id: "related-anomalies-heading",
					title: "Related anomalies",
					hint: countLabel(sorted.length, "detector incident"),
				}),
				h.div(
					[h.Class("overflow-hidden rounded-md border border-border/60 divide-y divide-border/60")],
					sorted.map((incident) =>
						anomalyRow(h, {
							incident,
							nowMs: options.nowMs,
							timeZone: options.timeZone,
							variant: "compact",
						}),
					),
				),
			],
		),
	]
}

/** "Anomaly open": critical when any open incident is. */
export const openAnomalyBadge = <M>(
	h: HtmlBuilder<M>,
	incidents: ReadonlyArray<AnomalyIncidentDocument>,
): ReadonlyArray<Html> => {
	const open = incidents.filter((incident) => incident.status === "open")
	if (open.length === 0) return []
	const tone =
		SEVERITY_TONE[open.some((incident) => incident.severity === "critical") ? "critical" : "warning"]
	return [
		badge(h, { variant: "outline", className: tone.badge }, [
			h.span(
				[h.Class("flex items-center gap-1.5")],
				[statusDot(h, { tone: tone.tone }), "Anomaly open"],
			),
		]),
	]
}
