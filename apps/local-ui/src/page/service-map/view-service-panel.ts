import { resolveDbNodeStyle } from "@maple/ui/components/service-map/service-map-db-style"
import {
	aggregateServiceOverviews,
	dbNodeId,
	getServiceMapNodeColor,
} from "@maple/ui/components/service-map/service-map-utils"
import { getServiceColor } from "@maple/ui/lib/colors"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { formatErrorRate, formatLatency, formatRate } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import type * as ServiceMap from "@maple/web/service-map/map/service-map"
import { button, linkButton } from "@maple/web/ui/button"
import { icon } from "@maple/web/ui/icon"
import { scrollArea } from "@maple/web/ui/scroll-area"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LocalServiceMapData } from "./data"
import {
	metricTile,
	panelHeader,
	peerList,
	type PeerRow,
	rates,
	sectionTitle,
	serviceHref,
	serviceTracesHref,
} from "./view-panel-kit"

// The side panel for a selected service node.

export type PanelActions<M> = Readonly<{ onFocus: M; onClose: M }>

const peer = (name: string, range: string): Pick<PeerRow, "key" | "label" | "color" | "href"> => ({
	key: name,
	label: name,
	color: getServiceColor(name),
	href: serviceHref(name, range),
})

export const servicePanel = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		serviceName: string
		data: LocalServiceMapData
		colorMode: ServiceMap.ColorMode
		durationSeconds: number
		range: string
		actions: PanelActions<M>
	}>,
): Html => {
	const { serviceName, data, durationSeconds, range } = options
	// Several environments can report one service: merged exactly as the map node does.
	const overview = aggregateServiceOverviews(data.overviews).get(serviceName)
	const errorRate = overview?.errorRate ?? 0
	const p50 = overview?.p50LatencyMs ?? 0
	const p95 = overview?.p95LatencyMs ?? 0
	const accentColor = getServiceMapNodeColor(
		{ label: serviceName, kind: "service", errorRate, platform: data.platforms.get(serviceName) },
		options.colorMode,
	)
	const calls = data.edges
		.filter((e) => e.sourceService === serviceName)
		.map((e): PeerRow => ({ ...peer(e.targetService, range), ...rates(e, durationSeconds) }))
	const databases = data.dbEdges
		.filter((e) => e.sourceService === serviceName)
		.map((e): PeerRow => {
			const db = resolveDbNodeStyle(e.dbSystem, e.dbNamespace)
			return {
				key: dbNodeId(e.dbSystem, e.dbNamespace),
				label: db.title,
				color: db.color,
				...rates(e, durationSeconds),
			}
		})
	const calledBy = data.edges
		.filter((e) => e.targetService === serviceName)
		.map((e): PeerRow => ({ ...peer(e.sourceService, range), ...rates(e, durationSeconds) }))
	return h.div(
		[h.Class("flex h-full flex-col overflow-hidden bg-background")],
		[
			panelHeader(
				h,
				{
					accentColor,
					errorRate,
					title: serviceName,
					subtitle: overview?.serviceNamespace ? [overview.serviceNamespace] : undefined,
				},
				[
					button(
						h,
						{
							variant: "ghost",
							size: "icon-xs",
							attributes: [
								h.OnClick(options.actions.onFocus),
								h.Title("Focus the map on this service's neighborhood"),
							],
						},
						[icon(h, "MagnifierIcon")],
					),
					button(
						h,
						{
							variant: "ghost",
							size: "icon-xs",
							attributes: [h.OnClick(options.actions.onClose), h.AriaLabel("Close panel")],
						},
						[icon(h, "XmarkIcon")],
					),
				],
			),
			scrollArea(h, { className: "min-h-0 flex-1", idPrefix: "service-map-panel" }, [
				h.div(
					[h.Class("space-y-5 p-4")],
					[
						h.div(
							[h.Class("flex flex-wrap gap-2")],
							[
								linkButton(
									h,
									{ variant: "outline", size: "sm", href: serviceHref(serviceName, range) },
									["View service"],
								),
								linkButton(
									h,
									{
										variant: "outline",
										size: "sm",
										href: serviceTracesHref(serviceName, range),
									},
									["View traces"],
								),
							],
						),
						h.div(
							[h.Class("space-y-3")],
							[
								sectionTitle(h, "Metrics"),
								h.div(
									[h.Class("grid grid-cols-2 gap-x-6 gap-y-4")],
									[
										metricTile(h, {
											label: "Throughput",
											value: `${overview?.hasSampling ? "~" : ""}${formatRate(overview?.throughput ?? 0)}`,
											unit: "req/s",
										}),
										metricTile(h, {
											label: "Error rate",
											value: formatErrorRate(errorRate),
											className: errorRateClass(errorRate, {
												neutral: "text-foreground",
											}),
										}),
										metricTile(h, {
											label: "P50 latency",
											value: formatLatency(p50),
											className: latencyToneClass(p50, "p50"),
										}),
										// A p95 far above the service's own p50 is a tail problem worth flagging.
										metricTile(h, {
											label: "P95 latency",
											value: formatLatency(p95),
											className:
												p95 > p50 * 3
													? "text-severity-warn"
													: latencyToneClass(p95, "p95"),
										}),
									],
								),
							],
						),
						...peerList(h, "Calls", calls),
						...peerList(h, "Databases", databases),
						...peerList(h, "Called by", calledBy),
					],
				),
			]),
		],
	)
}
