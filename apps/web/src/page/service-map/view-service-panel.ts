import {
	aggregateServiceOverviews,
	CLOUDFLARE_COLOR,
	getServiceMapNodeColor,
} from "@maple/ui/components/service-map/service-map-utils"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import { EMPTY_VALUE, formatErrorRate, formatLatency, formatNumber, formatRate } from "@maple/ui/lib/format"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import type { ColorMode } from "../../service-map/map/state"
import { separator } from "../../ui/display"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import { iconButton } from "../../ui/icon-button"
import { scrollArea } from "../../ui/scroll-area"
import { statusDot } from "../../ui/status-dot"
import * as TabsView from "../../ui/tabs-view"
import type { ScopedRows } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { detailPanelHeader, edgeRow, healthTone, metricTile, metricValue, sampled } from "./view-panel-kit"
import { pickTimeSearch } from "../infra/kit/view-tabs"
import { infrastructureTab } from "./view-service-infra"
import * as ServiceMap from "../../service-map/map/service-map"

type H = HtmlBuilder<Message>

export type ServicePanelInputs = Readonly<{
	serviceId: string
	rows: ScopedRows
	durationSeconds: number
	colorMode: ColorMode
}>

const toMap = (message: ServiceMap.Message) => Message.GotMapMessage({ message })

const cloudflareOf = (model: Model, serviceId: string) =>
	Option.getOrUndefined(
		Option.flatMapNullishOr(
			model.map,
			(map) => map.source.rawNodes.find((node) => node.id === serviceId)?.data.cloudflare,
		),
	)

const header = (
	h: H,
	inputs: ServicePanelInputs,
	accentColor: string,
	errorRate: number,
	namespace: string,
) =>
	detailPanelHeader(
		h,
		accentColor,
		[
			statusDot(h, { tone: healthTone(errorRate) }),
			h.div(
				[h.Class("flex flex-col min-w-0")],
				[
					h.span([h.Class("text-sm font-semibold text-foreground truncate")], [inputs.serviceId]),
					...(namespace
						? [h.span([h.Class("text-3xs text-muted-foreground truncate")], [namespace])]
						: []),
				],
			),
		],
		[
			iconButton(
				h,
				{
					size: "icon-xs",
					label: "Focus the map on this service's neighborhood",
					attributes: [h.OnClick(toMap(ServiceMap.Message.ClickedFocusSelected()))],
				},
				[icon(h, "MagnifierIcon")],
			),
			h.a(
				[
					h.Class("text-3xs text-primary hover:text-primary/80 transition-colors"),
					h.Href(hrefOf(AppRoute.Service({ serviceName: inputs.serviceId, search: {} }))),
				],
				["View service"],
			),
			iconButton(
				h,
				{
					size: "icon-xs",
					label: "Close",
					attributes: [h.OnClick(toMap(ServiceMap.Message.ClickedCloseDetail()))],
				},
				[icon(h, "XmarkIcon")],
			),
		],
	)

type Overview = ScopedRows["overviews"][number] | undefined

const metrics = (h: H, overview: Overview): Html => {
	const errorRate = overview?.errorRate ?? 0
	return h.div(
		[h.Class("space-y-3")],
		[
			eyebrow(h, { as: "h4" }, ["Metrics"]),
			h.div(
				[h.Class("grid grid-cols-2 gap-x-6 gap-y-4")],
				[
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
						metricValue(h, overview === undefined ? undefined : errorRateClass(errorRate), [
							overview === undefined ? EMPTY_VALUE : formatErrorRate(errorRate),
						]),
					),
					metricTile(
						h,
						"P50 latency",
						metricValue(
							h,
							overview === undefined
								? undefined
								: latencyToneClass(overview.p50LatencyMs, "p50"),
							[overview === undefined ? EMPTY_VALUE : formatLatency(overview.p50LatencyMs)],
						),
					),
					metricTile(
						h,
						"P95 latency",
						metricValue(
							h,
							cn(
								overview === undefined
									? undefined
									: (overview.p95LatencyMs ?? 0) > overview.p50LatencyMs * 3
										? "text-severity-warn"
										: latencyToneClass(overview.p95LatencyMs ?? 0, "p95"),
							),
							[
								overview === undefined
									? EMPTY_VALUE
									: formatLatency(overview.p95LatencyMs ?? 0),
							],
						),
					),
				],
			),
		],
	)
}

const cloudflareSection = (h: H, cloudflare: NonNullable<ReturnType<typeof cloudflareOf>>): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			separator(h, "horizontal", undefined),
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					icon(h, "CloudflareIcon", { size: 12, style: { color: CLOUDFLARE_COLOR } }),
					eyebrow(h, { as: "h4" }, ["Cloudflare edge"]),
				],
			),
			h.div(
				[h.Class("grid grid-cols-2 gap-x-6 gap-y-4")],
				[
					metricTile(
						h,
						"Requests",
						metricValue(h, undefined, [formatNumber(cloudflare.requests)]),
						["edge-reported (unsampled)"],
					),
					metricTile(
						h,
						"Error rate",
						metricValue(h, errorRateClass(cloudflare.errorRate), [
							formatErrorRate(cloudflare.errorRate),
						]),
					),
					metricTile(
						h,
						"CPU p99",
						metricValue(
							h,
							cloudflare.cpuP99Ms === undefined
								? undefined
								: latencyToneClass(cloudflare.cpuP99Ms, "cpu"),
							[
								cloudflare.cpuP99Ms === undefined
									? EMPTY_VALUE
									: formatLatency(cloudflare.cpuP99Ms),
							],
						),
					),
					metricTile(
						h,
						"Duration p99",
						metricValue(h, cn(latencyToneClass(cloudflare.latencyP99Ms, "p99")), [
							formatLatency(cloudflare.latencyP99Ms),
						]),
					),
				],
			),
		],
	)

const edgeSection = (h: H, title: string, rows: ReadonlyArray<Html>): ReadonlyArray<Html> =>
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

const serviceTab = (
	h: H,
	model: Model,
	inputs: ServicePanelInputs,
	overview: Overview,
): ReadonlyArray<Html> => {
	const { serviceId, rows, durationSeconds } = inputs
	const cloudflare = cloudflareOf(model, serviceId)
	const dependencies = rows.edges.filter((edge) => edge.sourceService === serviceId)
	const calledBy = rows.edges.filter((edge) => edge.targetService === serviceId)
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
						dependencies.map((edge) =>
							edgeRow(h, {
								service: edge.targetService,
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
						"Called by",
						calledBy.map((edge) =>
							edgeRow(h, {
								service: edge.sourceService,
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

/** The service's panel: header, then the Service and Infrastructure tabs. */
export const servicePanel = (h: H, model: Model, inputs: ServicePanelInputs): Html => {
	// Same per-service aggregate the map node renders, so panel and node agree.
	const overview = [...aggregateServiceOverviews(inputs.rows.overviews)].find(
		([serviceName]) => serviceName === inputs.serviceId,
	)?.[1]
	const errorRate = overview?.errorRate ?? 0
	const platform = inputs.rows.platforms.find((row) => row.serviceName === inputs.serviceId)?.platform
	const accentColor = getServiceMapNodeColor(
		{ label: inputs.serviceId, kind: "service", errorRate, platform },
		inputs.colorMode,
	)
	const workloads = inputs.rows.workloads.filter((workload) => workload.serviceName === inputs.serviceId)
	const runtimes = inputs.rows.runtimes.filter((runtime) => runtime.serviceName === inputs.serviceId)
	const infraCount = workloads.length + runtimes.length
	return h.div(
		[h.Class("flex flex-col h-full bg-background overflow-hidden")],
		[
			header(h, inputs, accentColor, errorRate, overview?.serviceNamespace ?? ""),
			h.submodel({
				slotId: "service-map-service-tabs",
				model: model.serviceTabs,
				view: TabsView.view,
				toParentMessage: (message) => Message.GotServiceTabsMessage({ message }),
				viewInputs: {
					variant: "underline",
					labels: ["Service", "Infrastructure"],
					className: "flex flex-col flex-1 min-h-0",
					listClassName: "shrink-0 px-4 pt-2",
					panelClassName: "flex-1 min-h-0 mt-0",
					tabContent: (value, label) =>
						value === "service"
							? [icon(h, "NetworkNodesIcon", { size: 12 }), label]
							: [
									icon(h, "CubeIcon", { size: 12 }),
									label,
									...(infraCount > 0
										? [
												h.span(
													[
														h.Class(
															"ml-1 text-4xs tabular-nums text-foreground-subtle",
														),
													],
													[String(infraCount)],
												),
											]
										: []),
								],
					panel: (value) =>
						value === "service"
							? serviceTab(h, model, inputs, overview)
							: infrastructureTab(h, workloads, runtimes, pickTimeSearch(model.search)),
				},
			}),
		],
	)
}
