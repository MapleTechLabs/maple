import { resolveDbNodeStyle, withAlpha } from "@maple/ui/components/service-map/service-map-db-style"
import { formatRate } from "@maple/ui/lib/format"
import { DB_ICON } from "@maple/views/service-map/map/node-card"
import {
	detailPanelHeader,
	edgeRow,
	healthTone,
	metricTile,
	metricValue,
	sampled,
} from "@maple/views/service-map/panel/kit"
import { separator } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { grid } from "@maple/views/ui/grid"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { scrollArea } from "@maple/views/ui/scroll-area"
import { sidePanelFrame } from "@maple/views/ui/side-panel"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { errorRateValue, latencyValue } from "@maple/views/ui/values"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LocalServiceMapData } from "./data"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { Array as Arr } from "effect"

// The side panel for a selected database node, on the service panel's kit.

const sum = (values: ReadonlyArray<number>): number => Arr.reduce(values, 0, (total, value) => total + value)

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
	const callers = Arr.filter(
		options.data.dbEdges,
		(e) => e.dbSystem === options.dbSystem && e.dbNamespace === options.dbNamespace,
	)
	const totalCalls = sum(Arr.map(callers, (e) => e.callCount))
	const totalErrors = sum(Arr.map(callers, (e) => e.errorCount))
	const estimatedCalls = sum(Arr.map(callers, (e) => e.estimatedCallCount))
	const errorRate = totalCalls > 0 ? totalErrors / totalCalls : 0
	const avgLatencyMs =
		totalCalls > 0 ? sum(Arr.map(callers, (e) => e.avgDurationMs * e.callCount)) / totalCalls : 0
	// The worst caller's p95 (a real p95); the max stands in, labelled as one, when no digest exists.
	const p95 = Arr.reduce(callers, 0, (worst, e) => Math.max(worst, e.p95DurationMs))
	const max = Arr.reduce(callers, 0, (worst, e) => Math.max(worst, e.maxDurationMs))
	const hasSampling = Arr.some(callers, (e) => e.hasSampling)
	const db = resolveDbNodeStyle(options.dbSystem, options.dbNamespace)
	const subtitle = hstack(
		h,
		{ as: "span", gap: "1", className: typographyClass({ size: "3xs", tone: "muted" }) },
		[
			hstack(
				h,
				{
					align: "center",
					justify: "center",
					inline: true,
					as: "span",
					className: "size-3.5 rounded-sm",
					attributes: [h.Style({ "background-color": withAlpha(db.color, 0.16), color: db.color })],
				},
				[icon(h, DB_ICON[db.icon], { size: 10 })],
			),
			db.systemLabel,
		],
	)
	const latencyTile =
		p95 > 0
			? metricTile(
					h,
					"P95 latency",
					metricValue(h, undefined, [latencyValue(h, { ms: p95, scale: "p95" })]),
				)
			: metricTile(
					h,
					"Max latency",
					metricValue(h, undefined, [latencyValue(h, { ms: max, scale: "p95" })]),
					["slowest call in the window"],
				)
	return sidePanelFrame(h, [
		detailPanelHeader(
			h,
			db.color,
			[
				statusDot(h, { tone: healthTone(errorRate) }),
				vstack(h, { shrink: true }, [
					typography(h, { size: "sm", weight: "semibold", tone: "foreground", truncate: true }, [
						db.title,
					]),
					subtitle,
				]),
			],
			[
				iconButton(h, { size: "icon-xs", label: "Close", attributes: [h.OnClick(options.onClose)] }, [
					icon(h, "XmarkIcon"),
				]),
			],
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
									metricValue(
										h,
										undefined,
										sampled(
											hasSampling,
											formatRate(estimatedCalls / Math.max(durationSeconds, 1)),
										),
									),
									["calls/s"],
								),
								metricTile(
									h,
									"Error rate",
									metricValue(h, undefined, [errorRateValue(h, { rate: errorRate })]),
								),
								metricTile(
									h,
									"Avg latency",
									metricValue(h, undefined, [
										latencyValue(h, { ms: avgLatencyMs, scale: "avg" }),
									]),
								),
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
											Arr.map(callers, (edge) =>
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
