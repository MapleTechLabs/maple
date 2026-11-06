import type { AnomalyIncidentId } from "@maple/domain/http"
import type { V2AnomalyIncident, V2AnomalyIncidentTimeseries } from "@maple/domain/http/v2"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	META_CHIP_CLASS,
	SIGNAL_LABEL,
	TRIAGE_STATUS_CHIP,
	deviation,
	formatSignalValue,
} from "@maple/web-data/anomalies/format"
import { Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Chart from "@maple/views/charts/chart"
import type { ChartRuntime } from "@maple/views/charts/chart-runtime"
import type { ThemeColors } from "@maple/views/charts/theme-colors"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { anomalyIncidentFromV2 } from "../../../lib/services/anomalies"
import { AppRoute, hrefOf } from "../../../route"
import { anomalyFingerprintRow, anomalySignalChart, anomalySummary } from "../../anomalies/kit/evidence"

// An anomaly rule's incident: the detector's evidence (its signal against the baseline, the
// values, the grouped errors) and the way to the anomaly, its issue and its triage.

/** What the evidence section draws from: the page reads it off its Model, the lab off a fixture. */
export type AnomalyEvidenceInputs<M> = Readonly<{
	anomalyIncidentId: AnomalyIncidentId
	anomaly: AsyncData.AsyncData<V2AnomalyIncident, LoadFailure>
	timeseries: AsyncData.AsyncData<V2AnomalyIncidentTimeseries, LoadFailure>
	chart: Chart.Model
	toChartMessage: (message: Chart.Message) => M
	chartRuntime: ChartRuntime
	colors: ThemeColors | null
	now: number
	timeZone: string
}>

const anomalyHref = (id: AnomalyIncidentId): string => hrefOf(AppRoute.Anomaly({ incidentId: id }))

const openAnomalyLink = <M>(h: HtmlBuilder<M>, id: AnomalyIncidentId): Html =>
	linkButton(h, { size: "sm", variant: "outline", href: anomalyHref(id) }, [
		"Open anomaly",
		icon(h, "ArrowRightIcon"),
	])

const loaded = <M>(h: HtmlBuilder<M>, inputs: AnomalyEvidenceInputs<M>, wire: V2AnomalyIncident): Html => {
	const anomaly = anomalyIncidentFromV2(wire)
	const fmt = (value: number) => formatSignalValue(anomaly.signalType, value)
	const triage = TRIAGE_STATUS_CHIP[anomaly.triageStatus]
	return h.div(
		[h.Class("space-y-4")],
		[
			anomalySummary(h, anomaly, inputs.now),
			anomalySignalChart(h, {
				chartId: "alert-incident-anomaly",
				chart: inputs.chart,
				toChartMessage: inputs.toChartMessage,
				timeseries: inputs.timeseries,
				incident: anomaly,
				colors: inputs.colors,
				chartRuntime: inputs.chartRuntime,
				timeZone: inputs.timeZone,
			}),
			keyValueList(h, { layout: "split", className: "max-w-md" }, [
				keyValue(h, { label: "Signal" }, [SIGNAL_LABEL[anomaly.signalType]]),
				keyValue(h, { label: "Service", title: anomaly.serviceName }, [
					anomaly.serviceName || EMPTY_VALUE,
				]),
				keyValue(h, { label: "Environment" }, [anomaly.deploymentEnv || EMPTY_VALUE]),
				keyValue(h, { label: "Observed", mono: true }, [fmt(anomaly.lastObservedValue)]),
				keyValue(h, { label: "Baseline", mono: true }, [fmt(anomaly.baselineMedian)]),
				keyValue(h, { label: "Deviation", mono: true }, [deviation(anomaly).label]),
			]),
			...(anomaly.fingerprints.length > 0
				? [
						h.div(
							[h.Class("space-y-1")],
							[
								typography(h, { size: "xs", tone: "muted", as: "p" }, [
									`Grouped errors · ${anomaly.fingerprints.length}`,
								]),
								h.div(
									[h.Class("max-w-md")],
									Arr.map(anomaly.fingerprints, (fingerprint) =>
										anomalyFingerprintRow(h, anomaly, fingerprint),
									),
								),
							],
						),
					]
				: []),
			hstack(h, { gap: "2", wrap: true }, [
				openAnomalyLink(h, inputs.anomalyIncidentId),
				...(anomaly.errorIssueId === null
					? []
					: [
							linkButton(
								h,
								{
									size: "sm",
									variant: "outline",
									href: hrefOf(
										AppRoute.ErrorIssue({ issueId: anomaly.errorIssueId, search: {} }),
									),
								},
								["Open issue", icon(h, "ArrowRightIcon")],
							),
						]),
				triage === null
					? typography(h, { size: "xs", tone: "muted" }, ["No AI triage yet"])
					: badge(
							h,
							{
								pill: true,
								size: "sm",
								className: cn(META_CHIP_CLASS, "font-medium", triage.tone),
							},
							[triage.label],
						),
			]),
		],
	)
}

/** The anomaly evidence section of an anomaly rule's incident, under its "Anomaly · group" heading. */
export const anomalyEvidence = <M>(
	h: HtmlBuilder<M>,
	heading: string,
	inputs: AnomalyEvidenceInputs<M>,
): Html =>
	h.section(
		[h.Class("space-y-3")],
		[
			eyebrow(h, { as: "h2" }, [heading]),
			AsyncData.match(inputs.anomaly, {
				onIdle: () => skeleton(h, "h-[300px] w-full"),
				onLoading: () => skeleton(h, "h-[300px] w-full"),
				onFailure: () => failed(h, inputs.anomalyIncidentId),
				onStale: () => failed(h, inputs.anomalyIncidentId),
				onSuccess: (wire) => loaded(h, inputs, wire),
				onRefreshing: (wire) => loaded(h, inputs, wire),
			}),
		],
	)

const failed = <M>(h: HtmlBuilder<M>, id: AnomalyIncidentId): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			typography(h, { size: "sm", tone: "muted", as: "p" }, [
				"Couldn't load the anomaly behind this incident.",
			]),
			openAnomalyLink(h, id),
		],
	)
