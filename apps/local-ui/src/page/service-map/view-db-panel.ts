import { resolveDbNodeStyle, withAlpha } from "@maple/ui/components/service-map/service-map-db-style"
import { getServiceColor } from "@maple/ui/lib/colors"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatLatency, formatRate } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { DB_ICON } from "@maple/web/service-map/map/node-card"
import { button } from "@maple/web/ui/button"
import { icon } from "@maple/web/ui/icon"
import { scrollArea } from "@maple/web/ui/scroll-area"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LocalServiceMapData } from "./data"
import { metricTile, panelHeader, peerList, type PeerRow, rates, sectionTitle, serviceHref } from "./view-panel-kit"

// The side panel for a selected database node.

const sum = (values: ReadonlyArray<number>): number => values.reduce((total, value) => total + value, 0)

export const databasePanel = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ dbSystem: string; dbNamespace: string; data: LocalServiceMapData; durationSeconds: number; range: string; onClose: M }>,
): Html => {
	const { durationSeconds, range } = options
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
	const calledBy = callers.map(
		(e): PeerRow => ({
			key: e.sourceService,
			label: e.sourceService,
			color: getServiceColor(e.sourceService),
			href: serviceHref(e.sourceService, range),
			...rates(e, durationSeconds),
		}),
	)
	const subtitle = h.span(
		[h.Class("flex items-center gap-1")],
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
			? metricTile(h, { label: "P95 latency", value: formatLatency(p95), className: latencyToneClass(p95, "p95") })
			: metricTile(h, { label: "Max latency", value: formatLatency(max), title: "Slowest call in the window" })
	return h.div(
		[h.Class("flex h-full flex-col overflow-hidden bg-background")],
		[
			panelHeader(h, { accentColor: db.color, errorRate, title: db.title, subtitle: [subtitle] }, [
				button(h, { variant: "ghost", size: "icon-xs", attributes: [h.OnClick(options.onClose), h.AriaLabel("Close panel")] }, [
					icon(h, "XmarkIcon"),
				]),
			]),
			scrollArea(h, { className: "min-h-0 flex-1", idPrefix: "service-map-db-panel" }, [
				h.div(
					[h.Class("space-y-5 p-4")],
					[
						h.div(
							[h.Class("space-y-3")],
							[
								sectionTitle(h, "Metrics"),
								h.div(
									[h.Class("grid grid-cols-2 gap-x-6 gap-y-4")],
									[
										metricTile(h, {
											label: "Calls",
											value: `${hasSampling ? "~" : ""}${formatRate(estimatedCalls / Math.max(durationSeconds, 1))}`,
											unit: "calls/s",
										}),
										metricTile(h, { label: "Error rate", value: formatErrorRate(errorRate), className: errorRateClass(errorRate, { neutral: "text-foreground" }) }),
										metricTile(h, { label: "Avg latency", value: formatLatency(avgLatencyMs), className: latencyToneClass(avgLatencyMs, "avg") }),
										latencyTile,
									],
								),
							],
						),
						...peerList(h, "Called by", calledBy),
					],
				),
			]),
		],
	)
}
