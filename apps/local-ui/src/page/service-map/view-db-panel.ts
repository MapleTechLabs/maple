import { resolveDbNodeStyle, withAlpha } from "@maple/ui/components/service-map/service-map-db-style"
import { formatRate } from "@maple/ui/lib/format"
import { DB_ICON } from "@maple/views/service-map/map/node-card"
import { detailPanelHeader, edgeRow, healthTone, metricTile, metricValue, sampled } from "@maple/views/service-map/panel/kit"
import { separator } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { grid } from "@maple/views/ui/grid"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { scrollArea } from "@maple/views/ui/scroll-area"
import { sidePanelFrame } from "@maple/views/ui/side-panel"
import { vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { errorRateValue, latencyValue } from "@maple/views/ui/values"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LocalServiceMapData } from "./data"

// The side panel for a selected database node, on the service panel's kit.

const sum = (values: ReadonlyArray<number>): number => values.reduce((total, value) => total + value, 0)

export const databasePanel = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		dbSystem: string
		dbNamespace: string
		data: LocalServiceMapData
		durationSeconds: number
		serviceHref: (service: string) => string
		onClose: M
	}>,
): Html => {
	const { durationSeconds } = options
	const callers = options.data.dbEdges.filter((e) => e.dbSystem === options.dbSystem && e.dbNamespace === options.dbNamespace)
	const totalCalls = sum(callers.map((e) => e.callCount))
	const totalErrors = sum(callers.map((e) => e.errorCount))
	const estimatedCalls = sum(callers.map((e) => e.estimatedCallCount))
	const errorRate = totalCalls > 0 ? totalErrors / totalCalls : 0
	const avgLatencyMs = totalCalls > 0 ? sum(callers.map((e) => e.avgDurationMs * e.callCount)) / totalCalls : 0
	// The worst caller's p95 (a real p95); the max stands in, labelled as one, when no digest exists.
	const p95 = callers.reduce((worst, e) => Math.max(worst, e.p95DurationMs), 0)
	const max = callers.reduce((worst, e) => Math.max(worst, e.maxDurationMs), 0)
	const hasSampling = callers.some((e) => e.hasSampling)
	const db = resolveDbNodeStyle(options.dbSystem, options.dbNamespace)
	const subtitle = h.span(
		[h.Class("flex items-center gap-1 text-3xs text-muted-foreground")],
		[
			h.span(
				[
					h.Class("inline-flex size-3.5 items-center justify-center rounded-sm"),
					h.Style({ "background-color": withAlpha(db.color, 0.16), color: db.color }),
				],
				[icon(h, DB_ICON[db.icon], { size: 10 })],
			),
			db.systemLabel,
		],
	)
	const latencyTile =
		p95 > 0
			? metricTile(h, "P95 latency", metricValue(h, undefined, [latencyValue(h, { ms: p95, scale: "p95" })]))
			: metricTile(h, "Max latency", metricValue(h, undefined, [latencyValue(h, { ms: max, scale: "p95" })]), [
					"slowest call in the window",
				])
	return sidePanelFrame(h, [
		detailPanelHeader(
			h,
			db.color,
			[
				statusDot(h, { tone: healthTone(errorRate) }),
				vstack(h, { shrink: true }, [h.span([h.Class("text-sm font-semibold text-foreground truncate")], [db.title]), subtitle]),
			],
			[iconButton(h, { size: "icon-xs", label: "Close", attributes: [h.OnClick(options.onClose)] }, [icon(h, "XmarkIcon")])],
		),
		scrollArea(h, { idPrefix: "service-map-db-panel", className: "min-h-0 flex-1" }, [
			h.div(
				[h.Class("p-4 space-y-5")],
				[
					h.div(
						[h.Class("space-y-3")],
						[
							eyebrow(h, { as: "h4" }, ["Metrics"]),
							grid(h, { cols: 2, gapX: "6", gapY: "4" }, [
								metricTile(
									h,
									"Calls",
									metricValue(h, undefined, sampled(hasSampling, formatRate(estimatedCalls / Math.max(durationSeconds, 1)))),
									["calls/s"],
								),
								metricTile(h, "Error rate", metricValue(h, undefined, [errorRateValue(h, { rate: errorRate })])),
								metricTile(h, "Avg latency", metricValue(h, undefined, [latencyValue(h, { ms: avgLatencyMs, scale: "avg" })])),
								latencyTile,
							]),
						],
					),
					...(callers.length === 0
						? []
						: [
								h.div(
									[h.Class("space-y-3")],
									[
										separator(h, "horizontal", undefined),
										eyebrow(h, { as: "h4" }, ["Called by"]),
										h.div(
											[h.Class("space-y-1.5")],
											callers.map((edge) =>
												edgeRow(h, {
													service: edge.sourceService,
													href: options.serviceHref(edge.sourceService),
													edge,
													durationSeconds,
													unit: "req/s",
													highlightError: true,
													explainSampling: true,
												}),
											),
										),
									],
								),
							]),
				],
			),
		]),
	])
}
