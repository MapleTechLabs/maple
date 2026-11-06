import { resolveDbNodeStyle } from "@maple/ui/components/service-map/service-map-db-style"
import {
	aggregateServiceOverviews,
	CLOUDFLARE_COLOR,
	dbNodeId,
	getServiceMapNodeColor,
} from "@maple/ui/components/service-map/service-map-utils"
import type {
	ServiceMapDbEdgeRow,
	ServiceMapEdgeRow,
	ServiceMapOverviewRow,
	ServicePlatform,
} from "@maple/ui/components/service-map/service-map-types"
import { EMPTY_VALUE, formatNumber, formatRate } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { separator } from "../../ui/display"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import { iconButton } from "../../ui/icon-button"
import { scrollArea } from "../../ui/scroll-area"
import { statusDot } from "../../ui/status-dot"
import { errorRateValue, latencyValue } from "../../ui/values"
import type * as Tabs from "../../ui/tabs"
import * as TabsView from "../../ui/tabs-view"
import { textLinkClass } from "../../ui/text-link"
import { hstack, vstack, vstackClass } from "../../ui/stack"
import { sidePanelFrame } from "../../ui/side-panel"
import { grid } from "../../ui/grid"
import * as ServiceMap from "../map/service-map"
import { detailPanelHeader, edgeRow, healthTone, metricTile, metricValue, sampled } from "./kit"
import { Array as Arr, Option } from "effect"

// A selected service node's side panel. The app hands in the map's rows, its service and traces hrefs
// and, where it can back one, the Infrastructure tab.

type Overview = (ServiceMapOverviewRow & { p95LatencyMs?: number }) | undefined

/** The Infrastructure tab: the app's content and the tab strip it keeps in its Model. */
export type InfrastructureTab<M> = Readonly<{
	tabs: Tabs.Model
	toTabsMessage: (message: Tabs.Message) => M
	count: number
	content: () => ReadonlyArray<Html>
}>

export type ServicePanelInputs<M> = Readonly<{
	serviceId: string
	map: ServiceMap.Model
	overviews: ReadonlyArray<ServiceMapOverviewRow & { p95LatencyMs?: number }>
	edges: ReadonlyArray<ServiceMapEdgeRow>
	dbEdges: ReadonlyArray<ServiceMapDbEdgeRow>
	platform: ServicePlatform | undefined
	durationSeconds: number
	/** A service's own page: the header link and every peer row. */
	serviceHref: (service: string) => string
	/** The spans this service wrote, in the app's traces list. */
	tracesHref: string
	toMapMessage: (message: ServiceMap.Message) => M
	infrastructure?: InfrastructureTab<M>
}>

const cloudflareOf = <M>(inputs: ServicePanelInputs<M>) =>
	Option.getOrUndefined(
		Option.map(
			Arr.findFirst(inputs.map.source.rawNodes, (node) => node.id === inputs.serviceId),
			(node) => node.data.cloudflare,
		),
	)

const header = <M>(
	h: HtmlBuilder<M>,
	inputs: ServicePanelInputs<M>,
	accentColor: string,
	errorRate: number,
	namespace: string,
) =>
	detailPanelHeader(
		h,
		accentColor,
		[
			statusDot(h, { tone: healthTone(errorRate) }),
			vstack(h, { shrink: true }, [
				h.span([h.Class("text-sm font-semibold text-foreground truncate")], [inputs.serviceId]),
				...(namespace
					? [h.span([h.Class("text-3xs text-muted-foreground truncate")], [namespace])]
					: []),
			]),
		],
		[
			iconButton(
				h,
				{
					size: "icon-xs",
					label: "Focus the map on this service's neighborhood",
					attributes: [h.OnClick(inputs.toMapMessage(ServiceMap.Message.ClickedFocusSelected()))],
				},
				[icon(h, "MagnifierIcon")],
			),
			h.a(
				[
					h.Class(textLinkClass("primary", false, "text-3xs")),
					h.Href(inputs.serviceHref(inputs.serviceId)),
				],
				["View service"],
			),
			h.a(
				[h.Class(textLinkClass("primary", false, "text-3xs")), h.Href(inputs.tracesHref)],
				["View traces"],
			),
			iconButton(
				h,
				{
					size: "icon-xs",
					label: "Close",
					attributes: [h.OnClick(inputs.toMapMessage(ServiceMap.Message.ClickedCloseDetail()))],
				},
				[icon(h, "XmarkIcon")],
			),
		],
	)

const metrics = <M>(h: HtmlBuilder<M>, overview: Overview): Html => {
	const errorRate = overview?.errorRate ?? 0
	return h.div(
		[h.Class("space-y-3")],
		[
			eyebrow(h, { as: "h4" }, ["Metrics"]),
			grid(h, { cols: 2, gapX: "6", gapY: "4" }, [
				metricTile(
					h,
					"Throughput",
					metricValue(
						h,
						undefined,
						overview === undefined
							? [EMPTY_VALUE]
							: sampled(overview.hasSampling, formatRate(overview.throughput)),
					),
					["req/s"],
				),
				metricTile(
					h,
					"Error rate",
					metricValue(h, undefined, [
						overview === undefined ? EMPTY_VALUE : errorRateValue(h, { rate: errorRate }),
					]),
				),
				metricTile(
					h,
					"P50 latency",
					metricValue(h, undefined, [
						overview === undefined
							? EMPTY_VALUE
							: latencyValue(h, { ms: overview.p50LatencyMs, scale: "p50" }),
					]),
				),
				metricTile(
					h,
					"P95 latency",
					metricValue(h, undefined, [
						overview === undefined
							? EMPTY_VALUE
							: latencyValue(h, {
									ms: overview.p95LatencyMs ?? 0,
									scale: "p95",
									// A p95 three times its p50 is a long tail, whatever the absolute level.
									className:
										(overview.p95LatencyMs ?? 0) > overview.p50LatencyMs * 3
											? "text-severity-warn"
											: undefined,
								}),
					]),
				),
			]),
		],
	)
}

const cloudflareSection = <M>(
	h: HtmlBuilder<M>,
	cloudflare: NonNullable<ReturnType<typeof cloudflareOf>>,
): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			separator(h, "horizontal", undefined),
			hstack(h, { gap: "1.5" }, [
				icon(h, "CloudflareIcon", { size: 12, style: { color: CLOUDFLARE_COLOR } }),
				eyebrow(h, { as: "h4" }, ["Cloudflare edge"]),
			]),
			grid(h, { cols: 2, gapX: "6", gapY: "4" }, [
				metricTile(h, "Requests", metricValue(h, undefined, [formatNumber(cloudflare.requests)]), [
					"edge-reported (unsampled)",
				]),
				metricTile(
					h,
					"Error rate",
					metricValue(h, undefined, [errorRateValue(h, { rate: cloudflare.errorRate })]),
				),
				metricTile(
					h,
					"CPU p99",
					metricValue(h, undefined, [
						cloudflare.cpuP99Ms === undefined
							? EMPTY_VALUE
							: latencyValue(h, { ms: cloudflare.cpuP99Ms, scale: "cpu" }),
					]),
				),
				metricTile(
					h,
					"Duration p99",
					metricValue(h, undefined, [
						latencyValue(h, { ms: cloudflare.latencyP99Ms, scale: "p99" }),
					]),
				),
			]),
		],
	)

const edgeSection = <M>(h: HtmlBuilder<M>, title: string, rows: ReadonlyArray<Html>): ReadonlyArray<Html> =>
	rows.length === 0
		? []
		: [
				h.div(
					[h.Class("space-y-3")],
					[
						separator(h, "horizontal", undefined),
						eyebrow(h, { as: "h4" }, [title]),
						h.div([h.Class("space-y-1.5")], rows),
					],
				),
			]

const serviceTab = <M>(
	h: HtmlBuilder<M>,
	inputs: ServicePanelInputs<M>,
	overview: Overview,
): ReadonlyArray<Html> => {
	const { serviceId, edges, durationSeconds, serviceHref } = inputs
	const cloudflare = cloudflareOf(inputs)
	const dependencies = Arr.filter(edges, (edge) => edge.sourceService === serviceId)
	const calledBy = Arr.filter(edges, (edge) => edge.targetService === serviceId)
	const databases = Arr.filter(inputs.dbEdges, (edge) => edge.sourceService === serviceId)
	return [
		scrollArea(h, { idPrefix: "service-map-service-scroll", className: "h-full" }, [
			h.div(
				[h.Class("p-4 space-y-5")],
				[
					metrics(h, overview),
					...(cloudflare === undefined ? [] : [cloudflareSection(h, cloudflare)]),
					...edgeSection(
						h,
						"Dependencies",
						Arr.map(dependencies, (edge) =>
							edgeRow(h, {
								service: edge.targetService,
								href: serviceHref(edge.targetService),
								edge,
								durationSeconds,
								unit: "req/s",
								highlightError: true,
								explainSampling: true,
							}),
						),
					),
					...edgeSection(
						h,
						"Databases",
						Arr.map(databases, (edge) => {
							const db = resolveDbNodeStyle(edge.dbSystem, edge.dbNamespace)
							return edgeRow(h, {
								service: dbNodeId(edge.dbSystem, edge.dbNamespace),
								label: db.title,
								color: db.color,
								edge,
								durationSeconds,
								unit: "req/s",
								highlightError: true,
								explainSampling: true,
							})
						}),
					),
					...edgeSection(
						h,
						"Called by",
						Arr.map(calledBy, (edge) =>
							edgeRow(h, {
								service: edge.sourceService,
								href: serviceHref(edge.sourceService),
								edge,
								durationSeconds,
								unit: "req/s",
								explainSampling: true,
							}),
						),
					),
				],
			),
		]),
	]
}

const tabLabel = <M>(
	h: HtmlBuilder<M>,
	value: string,
	label: string,
	count: number,
): ReadonlyArray<Html | string> =>
	value === "service"
		? [icon(h, "NetworkNodesIcon", { size: 12 }), label]
		: [
				icon(h, "CubeIcon", { size: 12 }),
				label,
				...(count > 0
					? [
							h.span(
								[h.Class("ml-1 text-4xs tabular-nums text-foreground-subtle")],
								[String(count)],
							),
						]
					: []),
			]

/** The service's panel: header, then its metrics and peers, beside an Infrastructure tab when the app has one. */
export const servicePanel = <M>(h: HtmlBuilder<M>, inputs: ServicePanelInputs<M>): Html => {
	// Same per-service aggregate the map node renders, so panel and node agree.
	const overview = aggregateServiceOverviews(inputs.overviews).get(inputs.serviceId)
	const errorRate = overview?.errorRate ?? 0
	const accentColor = getServiceMapNodeColor(
		{ label: inputs.serviceId, kind: "service", errorRate, platform: inputs.platform },
		inputs.map.colorMode,
	)
	const infrastructure = inputs.infrastructure
	return sidePanelFrame(h, [
		header(h, inputs, accentColor, errorRate, overview?.serviceNamespace ?? ""),
		infrastructure === undefined
			? h.div([h.Class("flex-1 min-h-0")], serviceTab(h, inputs, overview))
			: h.submodel({
					slotId: "service-map-service-tabs",
					model: infrastructure.tabs,
					view: TabsView.view,
					toParentMessage: infrastructure.toTabsMessage,
					viewInputs: {
						variant: "underline",
						labels: ["Service", "Infrastructure"],
						className: vstackClass({ grow: true, className: "min-h-0" }),
						listClassName: "shrink-0 px-4 pt-2",
						panelClassName: "flex-1 min-h-0 mt-0",
						tabContent: (value, label) => tabLabel(h, value, label, infrastructure.count),
						panel: (value) =>
							value === "service" ? serviceTab(h, inputs, overview) : infrastructure.content(),
					},
				}),
	])
}
