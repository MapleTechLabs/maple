import { formatLatency, formatPercent } from "@maple/ui/lib/format"
import { LatencyLineChart, QueryBuilderBarChart } from "@maple/ui/components/charts"
import { ChartTooltipSuppressionProvider } from "@maple/ui/components/plot"
import { LinkedCursorOverlay, linkedCursorChartProps, useLinkedCursor } from "@/hooks/use-linked-cursor"
import { lazy, Suspense, useMemo } from "react"

import { Result, useAtom, useAtomValue } from "@/lib/effect-atom"
import { useGlobalNamespace } from "@/hooks/use-global-namespace"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { serviceMapLayoutAtomFamily } from "@/atoms/service-map-layout-atoms"
import { serviceMapViewPrefsAtomFamily } from "@/atoms/service-map-view-prefs-atoms"
import { Link } from "@tanstack/react-router"
import { displayError } from "@/lib/error-messages"
import { logClientError, logClientWarning } from "@/lib/services/common/telemetry"

import { cn } from "@maple/ui/lib/utils"
import { getServiceColor } from "@maple/ui/lib/colors"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@maple/ui/components/ui/empty"
import { Button } from "@maple/ui/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@maple/ui/components/ui/tabs"
import {
	ArrowRightIcon,
	CloudflareIcon,
	CubeIcon,
	ExternalLinkIcon,
	MagnifierIcon,
	NetworkNodesIcon,
	PlanetScaleIcon,
	XmarkIcon,
} from "@/components/icons"
import {
	getPlanetScaleBranchStatsResultAtom,
	getServiceDbQuerySummaryResultAtom,
	getServiceMapBundleResultAtom,
	getServiceMapCloudflareResultAtom,
	getServiceMapPlanetScaleResultAtom,
} from "@/lib/services/atoms/warehouse-query-atoms"
import type {
	CloudflareService,
	GetServiceMapInput,
	PlanetScaleDatabaseStat,
	ServiceDbEdge,
	ServiceDbQuerySummaryResponse,
	ServiceEdge,
	ServicePlatform,
} from "@/api/warehouse/service-map"
import type { ServiceOverview } from "@/api/warehouse/services"
import type { ServiceWorkload } from "@/api/warehouse/service-infra"
import {
	ServiceMapFlowCanvas,
	type ServiceMap3DRenderProps,
	type ServiceMapDetailPanelContext,
} from "@maple/ui/components/service-map/service-map-canvas"
import type { DeclutterFocus } from "@maple/ui/components/service-map/service-map-declutter"
import { ServiceMapLoading } from "@maple/ui/components/service-map/service-map-loading"
import {
	resolveDbNodePresentation,
	resolvePlanetScaleDbPresentation,
} from "@maple/ui/components/service-map/service-map-db"
import { PlanetScaleTopQueries } from "@/components/infra/planetscale/planetscale-top-queries"
import { formatStoragePercent, lagClass, utilizationClass } from "@/components/infra/planetscale/metrics"
import {
	buildFlowElements,
	CLOUDFLARE_COLOR,
	DB_NODE_PREFIX,
	parseDbNodeId,
	getServiceMapNodeColor,
	type CloudflareNodeMetrics,
	type PlanetScaleNodeMetrics,
	type ServiceMapColorMode,
} from "@maple/ui/components/service-map/service-map-utils"
import type {
	HyperdriveConfigInput,
	HyperdriveNodeInfo,
} from "@maple/ui/components/service-map/service-map-hyperdrive"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { useMapleOrganizationId } from "@/hooks/use-maple-organization"

const LiveServiceMap3D = lazy(() => import("./three/live-view"))

function renderLiveServiceMap3D(props: ServiceMap3DRenderProps) {
	return (
		<Suspense fallback={<ServiceMapLoading />}>
			<LiveServiceMap3D {...props} />
		</Suspense>
	)
}

const formatReplicationLag = (seconds: number) =>
	seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds * 1000)}ms`

function formatRate(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
	if (value >= 1) return value.toFixed(1)
	return value.toFixed(2)
}

function getHealthDotClass(errorRate: number): string {
	if (errorRate > 0.05) return "bg-severity-error"
	if (errorRate > 0.01) return "bg-severity-warn"
	return "bg-severity-info"
}

interface ServiceDetailPanelProps {
	serviceId: string
	edges: ServiceEdge[]
	overviews: ServiceOverview[]
	workloads: ServiceWorkload[]
	durationSeconds: number
	platforms: Map<string, ServicePlatform>
	colorMode: ServiceMapColorMode
	/** Cloudflare direct-integration analytics overlaid onto this instrumented Worker, if matched. */
	cloudflare?: CloudflareNodeMetrics
	/** Focus the map on this service's neighborhood. */
	onFocus: () => void
	onClose: () => void
}

function ServiceDetailPanel({
	serviceId,
	edges,
	overviews,
	workloads,
	durationSeconds,
	platforms,
	colorMode,
	cloudflare,
	onFocus,
	onClose,
}: ServiceDetailPanelProps) {
	const overview = overviews.find((o) => o.serviceName === serviceId)
	const errorRate = overview?.errorRate ?? 0
	const accentColor = getServiceMapNodeColor(
		{
			label: serviceId,
			kind: "service",
			errorRate,
			platform: platforms.get(serviceId),
		},
		colorMode,
	)

	const throughput = overview?.throughput ?? 0
	const hasSampling = overview?.hasSampling ?? false
	const avgLatencyMs = overview?.p50LatencyMs ?? 0
	const p95LatencyMs = overview?.p95LatencyMs ?? 0

	const dependencies = edges.filter((e) => e.sourceService === serviceId)
	const calledBy = edges.filter((e) => e.targetService === serviceId)
	const serviceWorkloads = workloads.filter((w) => w.serviceName === serviceId)

	return (
		<div className="flex flex-col h-full bg-background overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
				<div className="flex items-center gap-2 min-w-0">
					<div
						className="w-[3px] h-[18px] rounded-sm shrink-0"
						style={{ backgroundColor: accentColor }}
					/>
					<div className={cn("h-1.5 w-1.5 rounded-full shrink-0", getHealthDotClass(errorRate))} />
					<div className="flex flex-col min-w-0">
						<span className="text-sm font-semibold text-foreground truncate">{serviceId}</span>
						{overview?.serviceNamespace ? (
							<span className="text-[10px] text-muted-foreground truncate">
								{overview.serviceNamespace}
							</span>
						) : null}
					</div>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<Button
						variant="ghost"
						size="icon-xs"
						onClick={onFocus}
						title="Focus the map on this service's neighborhood"
					>
						<MagnifierIcon size={13} />
					</Button>
					<Link
						to="/services/$serviceName"
						params={{ serviceName: serviceId }}
						className="text-[10px] text-primary hover:text-primary/80 transition-colors"
					>
						View service
					</Link>
					<Button variant="ghost" size="icon-xs" onClick={onClose}>
						<XmarkIcon size={14} />
					</Button>
				</div>
			</div>

			<Tabs defaultValue="service" className="flex flex-col flex-1 min-h-0">
				<TabsList variant="underline" className="shrink-0 px-4 pt-2">
					<TabsTrigger value="service">
						<NetworkNodesIcon size={12} />
						Service
					</TabsTrigger>
					<TabsTrigger value="infrastructure">
						<CubeIcon size={12} />
						Infrastructure
						{serviceWorkloads.length > 0 && (
							<span className="ml-1 text-[9px] tabular-nums text-muted-foreground/70">
								{serviceWorkloads.length}
							</span>
						)}
					</TabsTrigger>
				</TabsList>

				<TabsContent value="service" className="flex-1 min-h-0 mt-0">
					<ScrollArea className="h-full">
						<div className="p-4 space-y-5">
							{/* Metrics */}
							<div className="space-y-3">
								<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
									Metrics
								</h4>
								<div className="grid grid-cols-2 gap-x-6 gap-y-4">
									<div className="space-y-0.5">
										<span className="text-[10px] text-muted-foreground">Throughput</span>
										<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
											{hasSampling ? "~" : ""}
											{formatRate(throughput)}
										</p>
										<span className="text-[10px] text-muted-foreground">req/s</span>
									</div>
									<div className="space-y-0.5">
										<span className="text-[10px] text-muted-foreground">Error Rate</span>
										<p
											className={cn(
												"text-xl font-semibold tabular-nums font-mono",
												errorRate > 0.05
													? "text-severity-error"
													: errorRate > 0.01
														? "text-severity-warn"
														: "text-foreground",
											)}
										>
											{(errorRate * 100).toFixed(1)}%
										</p>
									</div>
									<div className="space-y-0.5">
										<span className="text-[10px] text-muted-foreground">Avg Latency</span>
										<p
											className={cn(
												"text-xl font-semibold tabular-nums font-mono",
												latencyToneClass(avgLatencyMs, "avg"),
											)}
										>
											{formatLatency(avgLatencyMs)}
										</p>
									</div>
									<div className="space-y-0.5">
										<span className="text-[10px] text-muted-foreground">P95 Latency</span>
										<p
											className={cn(
												"text-xl font-semibold tabular-nums font-mono",
												// A p95 far above this service's own avg is a tail
												// problem worth flagging even when the absolute
												// magnitude is fine, so it outranks the ramp.
												p95LatencyMs > avgLatencyMs * 3
													? "text-severity-warn"
													: latencyToneClass(p95LatencyMs, "p95"),
											)}
										>
											{formatLatency(p95LatencyMs)}
										</p>
									</div>
								</div>
							</div>

							{/* Cloudflare edge (direct integration overlay) */}
							{cloudflare && (
								<div className="space-y-3">
									<div className="h-px bg-border" />
									<div className="flex items-center gap-1.5">
										<CloudflareIcon size={12} style={{ color: CLOUDFLARE_COLOR }} />
										<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
											Cloudflare edge
										</h4>
									</div>
									<div className="grid grid-cols-2 gap-x-6 gap-y-4">
										<div className="space-y-0.5">
											<span className="text-[10px] text-muted-foreground">
												Requests
											</span>
											<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
												{formatCompactCount(cloudflare.requests)}
											</p>
											<span className="text-[10px] text-muted-foreground">
												edge-reported (unsampled)
											</span>
										</div>
										<div className="space-y-0.5">
											<span className="text-[10px] text-muted-foreground">
												Error Rate
											</span>
											<p
												className={cn(
													"text-xl font-semibold tabular-nums font-mono",
													cloudflare.errorRate > 0.05
														? "text-severity-error"
														: cloudflare.errorRate > 0.01
															? "text-severity-warn"
															: "text-foreground",
												)}
											>
												{(cloudflare.errorRate * 100).toFixed(1)}%
											</p>
										</div>
										<div className="space-y-0.5">
											<span className="text-[10px] text-muted-foreground">CPU p99</span>
											<p
												className={cn(
													"text-xl font-semibold tabular-nums font-mono",
													latencyToneClass(cloudflare.cpuP99Ms ?? 0, "cpu"),
												)}
											>
												{formatLatency(cloudflare.cpuP99Ms ?? 0)}
											</p>
										</div>
										<div className="space-y-0.5">
											<span className="text-[10px] text-muted-foreground">
												Duration p99
											</span>
											<p
												className={cn(
													"text-xl font-semibold tabular-nums font-mono",
													latencyToneClass(cloudflare.latencyP99Ms, "p99"),
												)}
											>
												{formatLatency(cloudflare.latencyP99Ms)}
											</p>
										</div>
									</div>
								</div>
							)}

							{/* Dependencies */}
							{dependencies.length > 0 && (
								<div className="space-y-3">
									<div className="h-px bg-border" />
									<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
										Dependencies
									</h4>
									<div className="space-y-1.5">
										{dependencies.map((dep) => {
											const depColor = getServiceColor(dep.targetService)
											const depErrorRate = dep.errorRate
											const isError = depErrorRate > 0.05
											const safeDuration = Math.max(durationSeconds, 1)
											const depReqPerSec = dep.hasSampling
												? dep.estimatedCallCount / safeDuration
												: dep.callCount / safeDuration
											const depTracedReqPerSec = dep.callCount / safeDuration
											return (
												<div
													key={dep.targetService}
													className={cn(
														"flex items-center justify-between px-2.5 py-2 rounded-md border text-xs",
														isError
															? "bg-severity-error/[0.04] border-severity-error/[0.12]"
															: "bg-card border-border",
													)}
													title={
														dep.hasSampling
															? `Estimated x${dep.samplingWeight.toFixed(0)} from ${formatRate(depTracedReqPerSec)} traced req/s`
															: undefined
													}
												>
													<div className="flex items-center gap-1.5 min-w-0">
														<div
															className="w-[3px] h-3.5 rounded-sm shrink-0"
															style={{ backgroundColor: depColor }}
														/>
														<span className="text-foreground truncate">
															{dep.targetService}
														</span>
													</div>
													<div className="flex items-center gap-2 shrink-0 text-[10px]">
														<span className="text-muted-foreground tabular-nums font-mono">
															{dep.hasSampling ? "~" : ""}
															{formatRate(depReqPerSec)} req/s
														</span>
														<span
															className={cn(
																"tabular-nums font-mono",
																depErrorRate > 0.05
																	? "text-severity-error"
																	: depErrorRate > 0.01
																		? "text-severity-warn"
																		: "text-severity-info",
															)}
														>
															{(depErrorRate * 100).toFixed(1)}%
														</span>
													</div>
												</div>
											)
										})}
									</div>
								</div>
							)}

							{/* Called By */}
							{calledBy.length > 0 && (
								<div className="space-y-3">
									<div className="h-px bg-border" />
									<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
										Called By
									</h4>
									<div className="space-y-1.5">
										{calledBy.map((caller) => {
											const callerColor = getServiceColor(caller.sourceService)
											const callerErrorRate = caller.errorRate
											const safeDuration = Math.max(durationSeconds, 1)
											const callerReqPerSec = caller.hasSampling
												? caller.estimatedCallCount / safeDuration
												: caller.callCount / safeDuration
											const callerTracedReqPerSec = caller.callCount / safeDuration
											return (
												<div
													key={caller.sourceService}
													className="flex items-center justify-between px-2.5 py-2 rounded-md border bg-card border-border text-xs"
													title={
														caller.hasSampling
															? `Estimated x${caller.samplingWeight.toFixed(0)} from ${formatRate(callerTracedReqPerSec)} traced req/s`
															: undefined
													}
												>
													<div className="flex items-center gap-1.5 min-w-0">
														<div
															className="w-[3px] h-3.5 rounded-sm shrink-0"
															style={{ backgroundColor: callerColor }}
														/>
														<span className="text-foreground truncate">
															{caller.sourceService}
														</span>
													</div>
													<div className="flex items-center gap-2 shrink-0 text-[10px]">
														<span className="text-muted-foreground tabular-nums font-mono">
															{caller.hasSampling ? "~" : ""}
															{formatRate(callerReqPerSec)} req/s
														</span>
														<span
															className={cn(
																"tabular-nums font-mono",
																callerErrorRate > 0.05
																	? "text-severity-error"
																	: callerErrorRate > 0.01
																		? "text-severity-warn"
																		: "text-severity-info",
															)}
														>
															{(callerErrorRate * 100).toFixed(1)}%
														</span>
													</div>
												</div>
											)
										})}
									</div>
								</div>
							)}
						</div>
					</ScrollArea>
				</TabsContent>

				<TabsContent value="infrastructure" className="flex-1 min-h-0 mt-0">
					<ScrollArea className="h-full">
						<div className="p-4 space-y-4">
							{serviceWorkloads.length === 0 ? (
								<ServiceInfraEmptyState />
							) : (
								<div className="space-y-2">
									<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
										Kubernetes workloads
									</h4>
									<div className="space-y-2">
										{serviceWorkloads.map((wl) => (
											<ServiceWorkloadRow
												key={`${wl.workloadKind}/${wl.workloadName}/${wl.namespace}/${wl.clusterName}`}
												workload={wl}
											/>
										))}
									</div>
								</div>
							)}
						</div>
					</ScrollArea>
				</TabsContent>
			</Tabs>
		</div>
	)
}

function ServiceWorkloadRow({ workload }: { workload: ServiceWorkload }) {
	const knownKind: "deployment" | "statefulset" | "daemonset" | null =
		workload.workloadKind === "deployment" ||
		workload.workloadKind === "statefulset" ||
		workload.workloadKind === "daemonset"
			? workload.workloadKind
			: null
	return (
		<div className="rounded-md border bg-card p-3 space-y-2.5">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wide">
						<CubeIcon size={11} />
						<span>{workload.workloadKind}</span>
					</div>
					<p className="text-xs font-medium text-foreground truncate mt-0.5">
						{workload.workloadName}
					</p>
					<p className="text-[10px] text-muted-foreground mt-0.5 truncate">
						{workload.namespace || "default"}
						{workload.clusterName ? ` · ${workload.clusterName}` : ""}
					</p>
				</div>
				<div className="flex flex-col items-end gap-px shrink-0">
					<span className="text-[9px] text-muted-foreground/60 uppercase tracking-wide">pods</span>
					<span className="text-sm font-semibold text-foreground tabular-nums font-mono">
						{workload.podCount}
					</span>
				</div>
			</div>

			<div className="grid grid-cols-2 gap-2 text-[10px]">
				<div className="flex items-center justify-between rounded bg-muted/30 px-2 py-1">
					<span className="text-muted-foreground">CPU</span>
					<span className="font-mono tabular-nums text-foreground">
						{workload.avgCpuLimitUtilization == null
							? "—"
							: formatPercent(workload.avgCpuLimitUtilization)}
					</span>
				</div>
				<div className="flex items-center justify-between rounded bg-muted/30 px-2 py-1">
					<span className="text-muted-foreground">Memory</span>
					<span className="font-mono tabular-nums text-foreground">
						{workload.avgMemoryLimitUtilization == null
							? "—"
							: formatPercent(workload.avgMemoryLimitUtilization)}
					</span>
				</div>
			</div>

			<div className="flex items-center gap-3 pt-0.5">
				{knownKind && (
					<Link
						to="/infra/kubernetes/workloads/$kind/$workloadName"
						params={{ kind: knownKind, workloadName: workload.workloadName }}
						className="inline-flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
					>
						View workload <ArrowRightIcon size={10} />
					</Link>
				)}
				<Link
					to="/infra/kubernetes/pods"
					search={
						knownKind
							? {
									[`${knownKind}s`]: [workload.workloadName],
									namespaces: workload.namespace ? [workload.namespace] : undefined,
								}
							: {
									namespaces: workload.namespace ? [workload.namespace] : undefined,
								}
					}
					className="inline-flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
				>
					View pods <ArrowRightIcon size={10} />
				</Link>
			</div>
		</div>
	)
}

function ServiceInfraEmptyState() {
	return (
		<div className="rounded-md border border-dashed bg-muted/20 p-4 space-y-3">
			<div className="flex items-center gap-2">
				<CubeIcon size={14} className="text-muted-foreground/50" />
				<p className="text-xs font-medium text-foreground">No Kubernetes workloads found</p>
			</div>
			<p className="text-[11px] text-muted-foreground leading-relaxed">
				This service has no spans tagged with{" "}
				<code className="text-[10px] bg-muted px-1 py-0.5 rounded">k8s.deployment.name</code> in the
				selected window. Install the maple-k8s-infra Helm chart and label your namespace to enable
				infrastructure context:
			</p>
			<pre className="text-[10px] bg-muted px-2 py-1.5 rounded font-mono text-foreground overflow-x-auto">
				kubectl label namespace &lt;ns&gt; maple.io/instrument=true
			</pre>
		</div>
	)
}

// A single faint service-node glyph for the empty-state ghost graph — a rounded
// card with a status dot and two label lines, echoing the real ServiceMapNode.
function GhostNode({ x, y, color }: { x: number; y: number; color: string }) {
	return (
		<g>
			<rect
				x={x}
				y={y}
				width={72}
				height={30}
				rx={7}
				fill={color}
				fillOpacity={0.16}
				stroke={color}
				strokeOpacity={0.5}
				strokeWidth={1.25}
			/>
			<circle cx={x + 13} cy={y + 15} r={3} fill={color} fillOpacity={0.9} />
			<rect x={x + 22} y={y + 10} width={36} height={3} rx={1.5} fill={color} fillOpacity={0.34} />
			<rect x={x + 22} y={y + 17} width={22} height={3} rx={1.5} fill={color} fillOpacity={0.2} />
		</g>
	)
}

// Empty-state for the canvas, shown when there's no service activity at all in
// the window (no edges, db edges, or overviews → zero nodes). Echoes the live
// map's own language — the dotted Background grid plus a faint geometric service
// graph — so it reads as "the map, empty," not a blank void.
function ServiceMapEmptyState() {
	return (
		<div className="relative flex h-full items-center justify-center overflow-hidden">
			{/* Dotted grid: the live map's <Background variant={Dots} gap={16} size={1}>,
			    faded out toward the centre so it never competes with the message. */}
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 opacity-70"
				style={{
					backgroundImage: "radial-gradient(circle, var(--border) 1px, transparent 1px)",
					backgroundSize: "16px 16px",
					maskImage: "radial-gradient(ellipse 75% 72% at 50% 50%, transparent 26%, black 82%)",
					WebkitMaskImage:
						"radial-gradient(ellipse 75% 72% at 50% 50%, transparent 26%, black 82%)",
				}}
			/>

			<div className="relative z-10 flex flex-col items-center motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:[animation-duration:300ms]">
				{/* Ghost graph drawn in the node/edge vocabulary of the real map. */}
				<svg
					aria-hidden
					viewBox="0 0 460 178"
					className="pointer-events-none mb-1 w-[min(440px,76vw)] text-muted-foreground"
					fill="none"
					style={{
						maskImage: "radial-gradient(ellipse 62% 78% at 50% 50%, black 52%, transparent 100%)",
						WebkitMaskImage:
							"radial-gradient(ellipse 62% 78% at 50% 50%, black 52%, transparent 100%)",
					}}
				>
					<style>{`
						@keyframes sm-empty-flow { to { stroke-dashoffset: -16; } }
						.sm-empty-flow { animation: sm-empty-flow 1.8s linear infinite; }
						@media (prefers-reduced-motion: reduce) { .sm-empty-flow { animation: none; } }
					`}</style>
					<g stroke="currentColor" strokeWidth={1.25} strokeOpacity={0.3} strokeDasharray="4 4">
						<path d="M108 49 C 150 40, 162 30, 194 27" />
						<path className="sm-empty-flow" d="M108 49 C 150 66, 162 122, 194 131" />
						<path d="M266 27 C 312 34, 322 72, 352 79" />
						<path d="M266 131 C 312 122, 322 86, 352 79" />
					</g>
					<GhostNode x={36} y={34} color="var(--service-1)" />
					<GhostNode x={194} y={12} color="var(--service-2)" />
					<GhostNode x={194} y={116} color="var(--service-3)" />
					<GhostNode x={352} y={64} color="var(--service-5)" />
				</svg>

				<Empty className="flex-none bg-transparent py-0">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<NetworkNodesIcon size={18} />
						</EmptyMedia>
						<EmptyTitle>No service map yet</EmptyTitle>
						<EmptyDescription>
							Maple builds this map from cross-service spans in your traces. Once your services
							report calls to each other, they&rsquo;ll appear here as a connected graph.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<a
							href="https://maple.dev/docs/getting-started/introduction"
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1.5 text-foreground underline underline-offset-2 transition-colors hover:no-underline"
						>
							Set up instrumentation
							<ExternalLinkIcon size={12} />
						</a>
						<p className="text-xs text-muted-foreground/70">
							Seeing this with active services? Try widening the time range.
						</p>
					</EmptyContent>
				</Empty>
			</div>
		</div>
	)
}

interface DatabaseDetailPanelProps {
	dbSystem: string
	/** "" = the generic/legacy node (edges with no identified database). */
	dbNamespace: string
	/** Set when this database matched the org's PlanetScale inventory. */
	planetscale?: PlanetScaleNodeMetrics
	/** On the collapsed Hyperdrive node: configs resolved against the PlanetScale inventory. */
	hyperdrive?: ReadonlyArray<HyperdriveNodeInfo>
	dbEdges: ServiceDbEdge[]
	durationSeconds: number
	startTime: string
	endTime: string
	/** Scope the query summary to the map's selected environment; `undefined` = all. */
	deploymentEnv?: string
	onClose: () => void
}

function pickDbSummaryBucketSeconds(durationSeconds: number): number {
	if (durationSeconds <= 6 * 60 * 60) return 5 * 60
	if (durationSeconds <= 24 * 60 * 60) return 15 * 60
	if (durationSeconds <= 7 * 24 * 60 * 60) return 60 * 60
	return 6 * 60 * 60
}

function formatCompactCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
	return value.toLocaleString()
}

function formatQueryLabel(value: string): string {
	const collapsed = value.replace(/\s+/g, " ").trim()
	if (collapsed.length <= 96) return collapsed || "unknown query"
	return `${collapsed.slice(0, 78)}…${collapsed.slice(-16)}`
}

/**
 * Database query volume and latency over the same window.
 *
 * TWO plots, joined by the linked cursor, where this used to be one chart with a
 * left "count" axis and a right "latency" axis.
 *
 * That was once forced: `@tanstack/charts` carried a single y scale per chart
 * until 0.16.0, which added named scales (`scales: { …, latency: { channel: "y",
 * side: "right" } }` with marks binding `yScale`). So this is now a CHOICE.
 *
 * It stays split, and a right-hand axis was tried and backed out elsewhere on
 * the same reasoning: on a card this size a second axis means the shape of a
 * line says nothing until the reader has worked out which axis it belongs to.
 * The split landed somewhere better than the workaround it replaced, and every
 * other place in the product that shows volume beside latency already does it
 * this way:
 * `MetricsGrid` on the service detail page, host detail, infra correlation, the
 * Cloudflare zone panels. This chart was the outlier. Two plots also give each
 * series a full readable range instead of one axis squashing the other, and the
 * latency lines pick up the designated `--chart-p50`/`--chart-p95` tokens that
 * carry the same meaning product-wide.
 *
 * What is genuinely lost: the two spikes no longer share a pixel row, so
 * correlating them is a glance across a boundary rather than straight down. The
 * linked cursor is what recovers most of that.
 */
function DbQueryActivityChart({
	response,
	waiting,
}: {
	response: ServiceDbQuerySummaryResponse | null
	waiting: boolean
}) {
	const { containerProps } = useLinkedCursor(true)

	const { volumeRows, latencyRows } = useMemo(() => {
		const points = response?.timeseries ?? []
		return {
			// One series named for what the bars are, so the chart's own legend and
			// tooltip read "Queries" rather than a raw column name.
			volumeRows: points.map((point) => ({
				bucket: point.bucket,
				Queries: Math.round(point.estimatedQueryCount || point.queryCount),
			})),
			// `LatencyLineChart` is a fixed-metric chart: it reads these exact keys
			// and colours them from the shared percentile tokens.
			latencyRows: points.map((point) => ({
				bucket: point.bucket,
				p50LatencyMs: point.p50DurationMs,
				p95LatencyMs: point.p95DurationMs,
			})),
		}
	}, [response])

	if (!response && waiting) {
		return (
			<div className="flex h-44 items-center justify-center rounded-md border border-border/70 bg-muted/20 text-xs text-muted-foreground">
				Loading query activity…
			</div>
		)
	}

	if (volumeRows.length === 0) {
		return (
			<div className="flex h-44 items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/10 text-xs text-muted-foreground">
				No database query spans in this window
			</div>
		)
	}

	return (
		// One suppression provider over the pair: two charts mean two tooltips, and
		// only one should be open at a time. `MetricsGrid` mounts one for the same
		// reason.
		<ChartTooltipSuppressionProvider>
			<div {...containerProps} className="space-y-2">
				<div className="relative h-32 w-full" {...linkedCursorChartProps("db-query-volume")}>
					<QueryBuilderBarChart data={volumeRows} legend="hidden" className="h-full w-full" />
					<LinkedCursorOverlay chartId="db-query-volume" />
				</div>
				<div className="relative h-32 w-full" {...linkedCursorChartProps("db-query-latency")}>
					<LatencyLineChart data={latencyRows} legend="visible" className="h-full w-full" />
					<LinkedCursorOverlay chartId="db-query-latency" />
				</div>
			</div>
		</ChartTooltipSuppressionProvider>
	)
}

/**
 * PlanetScale overlay in the database detail panel: live health KPIs from the
 * scraped branch metrics plus a per-branch breakdown joined with the polled
 * inventory (production/ready flags).
 */
function PlanetScaleSection({
	planetscale,
	startTime,
	endTime,
}: {
	planetscale: PlanetScaleNodeMetrics
	startTime: string
	endTime: string
}) {
	const branchStatsResult = useRefreshableAtomValue(
		getPlanetScaleBranchStatsResultAtom({
			data: { database: planetscale.database, startTime, endTime },
		}),
	)
	const branchStats = Result.isSuccess(branchStatsResult) ? branchStatsResult.value.branches : []
	const branchInfoByName = new Map(planetscale.branches.map((branch) => [branch.name, branch]))
	// Branches with metrics first (production before dev), then metric-less
	// inventory branches (excluded from scraping or asleep).
	const statNames = new Set(branchStats.map((row) => row.branch))
	const idleBranches = planetscale.branches.filter((branch) => !statNames.has(branch.name))
	const stats = planetscale.stats

	return (
		<div className="space-y-3">
			<div className="h-px bg-border" />
			<div className="flex items-center gap-1.5">
				<PlanetScaleIcon size={12} className="shrink-0 text-muted-foreground" />
				<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
					PlanetScale
				</h4>
				<span className="ml-auto text-[10px] text-muted-foreground">
					{planetscale.kind === "postgresql" ? "Postgres" : "MySQL"} · {planetscale.branchCount}{" "}
					branch{planetscale.branchCount === 1 ? "" : "es"}
				</span>
			</div>

			{stats ? (
				<div className="grid grid-cols-2 gap-x-6 gap-y-4">
					<div className="space-y-0.5">
						<span className="text-[10px] text-muted-foreground">Connections</span>
						<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
							{formatRate(stats.connectionsAvg)}
						</p>
						<span className="text-[10px] text-muted-foreground">
							peak {formatRate(stats.connectionsMax)}
						</span>
					</div>
					{/* Thresholds come from the shared PlanetScale metrics module, so a
					    number tinted red here is tinted red on /infra/planetscale too. */}
					<div className="space-y-0.5">
						<span className="text-[10px] text-muted-foreground">CPU (max)</span>
						<p
							className={cn(
								"text-xl font-semibold tabular-nums font-mono text-foreground",
								utilizationClass(stats.cpuMaxPercent),
							)}
						>
							{stats.cpuMaxPercent.toFixed(0)}%
						</p>
					</div>
					<div className="space-y-0.5">
						<span className="text-[10px] text-muted-foreground">Memory (max)</span>
						<p
							className={cn(
								"text-xl font-semibold tabular-nums font-mono text-foreground",
								utilizationClass(stats.memMaxPercent),
							)}
						>
							{stats.memMaxPercent.toFixed(0)}%
						</p>
					</div>
					<div className="space-y-0.5">
						<span className="text-[10px] text-muted-foreground">Storage (max)</span>
						<p
							className={cn(
								"text-xl font-semibold tabular-nums font-mono text-foreground",
								stats.storageUsedPercent !== null &&
									utilizationClass(stats.storageUsedPercent),
							)}
						>
							{stats.storageUsedPercent === null
								? "—"
								: formatStoragePercent(stats.storageUsedPercent)}
						</p>
					</div>
					<div className="space-y-0.5">
						<span className="text-[10px] text-muted-foreground">Replica Lag (max)</span>
						<p
							className={cn(
								"text-xl font-semibold tabular-nums font-mono text-foreground",
								lagClass(stats.replicaLagMaxSeconds),
							)}
						>
							{formatReplicationLag(stats.replicaLagMaxSeconds)}
						</p>
					</div>
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					No PlanetScale metrics in this window yet — the scraper delivers them within a minute of
					connecting.
				</p>
			)}

			{Result.builder(branchStatsResult)
				.onError((error) => {
					const formatted = displayError(error)
					return (
						<div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs">
							<p className="font-medium text-destructive">{formatted.title}</p>
							<p className="mt-1 text-muted-foreground">{formatted.message}</p>
						</div>
					)
				})
				.orElse(() => null)}

			{!Result.isFailure(branchStatsResult) && (branchStats.length > 0 || idleBranches.length > 0) ? (
				<div className="space-y-1.5">
					{branchStats.map((row) => {
						const info = branchInfoByName.get(row.branch)
						return (
							<div
								key={row.branch}
								className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-2.5 py-2 text-xs"
							>
								<div className="flex min-w-0 items-center gap-1.5">
									<span className="truncate font-mono text-[11px] text-foreground">
										{row.branch}
									</span>
									{info?.production ? (
										<span className="shrink-0 rounded-sm bg-muted px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
											prod
										</span>
									) : null}
								</div>
								<div className="flex shrink-0 items-center gap-3 font-mono text-[10px] tabular-nums text-muted-foreground">
									<span>{formatRate(row.connectionsAvg)} conns</span>
									<span
										className={cn(
											row.cpuMaxPercent > 80
												? "text-severity-error"
												: row.cpuMaxPercent > 60
													? "text-severity-warn"
													: undefined,
										)}
									>
										{row.cpuMaxPercent.toFixed(0)}% cpu
									</span>
									<span
										className={cn(
											row.replicaLagMaxSeconds > 10
												? "text-severity-error"
												: row.replicaLagMaxSeconds > 1
													? "text-severity-warn"
													: undefined,
										)}
									>
										{formatReplicationLag(row.replicaLagMaxSeconds)} lag
									</span>
								</div>
							</div>
						)
					})}
					{idleBranches.map((branch) => (
						<div
							key={branch.name}
							className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-card px-2.5 py-2 text-xs opacity-70"
						>
							<div className="flex min-w-0 items-center gap-1.5">
								<span className="truncate font-mono text-[11px] text-muted-foreground">
									{branch.name}
								</span>
								{branch.production ? (
									<span className="shrink-0 rounded-sm bg-muted px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
										prod
									</span>
								) : null}
							</div>
							<span className="shrink-0 text-[10px] text-muted-foreground">
								{branch.ready ? "no metrics" : "not ready"}
							</span>
						</div>
					))}
				</div>
			) : null}

			<div className="space-y-2">
				<h5 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
					Top Queries (PlanetScale Insights)
				</h5>
				<PlanetScaleTopQueries
					database={planetscale.database}
					startTime={startTime}
					endTime={endTime}
				/>
			</div>
		</div>
	)
}

/**
 * Hyperdrive resolution in the database detail panel: the org's Hyperdrive
 * configs with the origin database each one fronts. Configs whose origin matched
 * the PlanetScale inventory link through to the infra page.
 */
function HyperdriveSection({ configs }: { configs: ReadonlyArray<HyperdriveNodeInfo> }) {
	return (
		<div className="space-y-3">
			<div className="h-px bg-border" />
			<div className="flex items-center gap-1.5">
				<CloudflareIcon size={12} className="shrink-0 text-muted-foreground" />
				<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
					Hyperdrive Configs
				</h4>
				<span className="ml-auto text-[10px] text-muted-foreground">
					{configs.length} config{configs.length === 1 ? "" : "s"}
				</span>
			</div>
			<div className="space-y-1.5">
				{configs.map((config) => (
					<div
						key={config.id}
						className="rounded-md border border-border bg-card px-2.5 py-2 text-xs"
					>
						<div className="flex items-center justify-between gap-2">
							<div className="flex min-w-0 items-center gap-1.5">
								<span className="truncate font-medium text-foreground">{config.name}</span>
								<span className="shrink-0 rounded-sm bg-muted px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
									{config.originScheme}
								</span>
							</div>
							<span
								className="shrink-0 font-mono text-[10px] text-muted-foreground/60"
								title={config.id}
							>
								{config.id.slice(0, 8)}
							</span>
						</div>
						<div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
							<ArrowRightIcon size={10} className="shrink-0 text-muted-foreground/60" />
							{config.matched ? (
								<Link
									to="/infra/planetscale/$dbName"
									params={{ dbName: config.matched.name }}
									className="flex min-w-0 items-center gap-1.5 text-foreground hover:underline"
								>
									<PlanetScaleIcon size={11} className="shrink-0 text-muted-foreground" />
									<span className="truncate font-mono">{config.matched.name}</span>
									<span className="shrink-0 text-[10px] text-muted-foreground">
										{config.matched.kind === "postgresql" ? "Postgres" : "MySQL"} on
										PlanetScale
									</span>
								</Link>
							) : config.isPlanetScaleHost ? (
								<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
									<PlanetScaleIcon size={11} className="shrink-0" />
									<span className="truncate font-mono">{config.originDatabase}</span>
									<span className="shrink-0 text-[10px]">
										PlanetScale (not in inventory)
									</span>
								</span>
							) : (
								<span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
									<span className="truncate font-mono">{config.originDatabase}</span>
									{config.originHost ? (
										<span className="truncate text-[10px] text-muted-foreground/60">
											{config.originHost}
										</span>
									) : (
										<span className="shrink-0 text-[10px] text-muted-foreground/60">
											private origin
										</span>
									)}
								</span>
							)}
						</div>
					</div>
				))}
			</div>
		</div>
	)
}

function DatabaseDetailPanel({
	dbSystem,
	dbNamespace,
	planetscale,
	hyperdrive,
	dbEdges,
	durationSeconds,
	startTime,
	endTime,
	deploymentEnv,
	onClose,
}: DatabaseDetailPanelProps) {
	const callers = dbEdges.filter((e) => e.dbSystem === dbSystem && e.dbNamespace === dbNamespace)
	const totalCalls = callers.reduce((sum, e) => sum + e.callCount, 0)
	const totalErrors = callers.reduce((sum, e) => sum + e.errorCount, 0)
	const errorRate = totalCalls > 0 ? totalErrors / totalCalls : 0
	const avgLatencyMs =
		totalCalls > 0 ? callers.reduce((sum, e) => sum + e.avgDurationMs * e.callCount, 0) / totalCalls : 0
	// Sample-weighted, to match the summary this stands in for. Summing the raw
	// `callCount` here put a raw number under the same tile that shows an
	// estimate once the summary lands, so the headline jumped by the sample rate.
	const estimatedCalls = callers.reduce((sum, e) => sum + e.estimatedCallCount, 0)
	const bucketSeconds = pickDbSummaryBucketSeconds(durationSeconds)
	const summaryResult = useRefreshableAtomValue(
		getServiceDbQuerySummaryResultAtom({
			data: {
				dbSystem,
				dbNamespace,
				startTime,
				endTime,
				deploymentEnv,
				bucketSeconds,
				topN: 8,
			},
		}),
	)
	const summaryResponse = Result.isSuccess(summaryResult) ? summaryResult.value : null
	const summary = summaryResponse?.summary ?? null
	const metricQueryCount = summary?.estimatedQueryCount ?? estimatedCalls
	const metricCallsPerSecond = metricQueryCount / Math.max(durationSeconds, 1)
	const metricErrorRate = summary?.errorRate ?? errorRate
	const metricAvgLatencyMs = summary?.avgDurationMs ?? avgLatencyMs
	// Quantiles have NO edge-level fallback, on purpose. The edges carry a max and
	// a mean, and substituting either renders a different statistic under a "P50" /
	// "P95" label until the summary resolves — which is how this panel showed 3s
	// beside the same node's real 7ms p95. Null renders as an em dash instead.
	const metricP50LatencyMs = summary?.p50DurationMs ?? null
	const metricP95LatencyMs = summary?.p95DurationMs ?? null
	const metricHasSampling = summary
		? summary.estimatedQueryCount > summary.queryCount + 1
		: callers.some((caller) => caller.hasSampling)
	const summaryWaiting = Boolean(summaryResult.waiting)

	const {
		title: dbTitle,
		badge: dbBadge,
		Icon: DbIcon,
		color: dbColor,
		branded: dbBranded,
	} = planetscale
		? resolvePlanetScaleDbPresentation(dbSystem, dbNamespace, planetscale.kind)
		: resolveDbNodePresentation(dbSystem, dbNamespace)

	return (
		<div className="flex flex-col h-full bg-background overflow-hidden">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
				<div className="flex items-center gap-2 min-w-0">
					<div
						className="w-[3px] h-[18px] rounded-sm shrink-0"
						style={{ backgroundColor: dbColor }}
					/>
					<DbIcon
						size={14}
						className="shrink-0"
						style={dbBranded ? undefined : { color: dbColor }}
					/>
					<span className="text-sm font-semibold text-foreground truncate">{dbTitle}</span>
					<span className="text-[9px] font-medium tracking-wide text-muted-foreground/60 uppercase shrink-0">
						{dbBadge}
					</span>
				</div>
				<Button variant="ghost" size="icon-xs" onClick={onClose}>
					<XmarkIcon size={14} />
				</Button>
			</div>

			<ScrollArea className="flex-1 min-h-0">
				<div className="p-4 space-y-5">
					<div className="space-y-3">
						<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
							Metrics
						</h4>
						<div className="grid grid-cols-2 gap-x-6 gap-y-4">
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">Queries</span>
								<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
									{metricHasSampling ? "~" : ""}
									{formatCompactCount(metricQueryCount)}
								</p>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">Throughput</span>
								<p className="text-xl font-semibold text-foreground tabular-nums font-mono">
									{metricHasSampling ? "~" : ""}
									{formatRate(metricCallsPerSecond)}
								</p>
								<span className="text-[10px] text-muted-foreground">calls/s</span>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">Error Rate</span>
								<p
									className={cn(
										"text-xl font-semibold tabular-nums font-mono",
										metricErrorRate > 0.05
											? "text-severity-error"
											: metricErrorRate > 0.01
												? "text-severity-warn"
												: "text-foreground",
									)}
								>
									{(metricErrorRate * 100).toFixed(1)}%
								</p>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">P50 Latency</span>
								<p
									className={cn(
										"text-xl font-semibold tabular-nums font-mono",
										metricP50LatencyMs === null
											? "text-muted-foreground"
											: latencyToneClass(metricP50LatencyMs, "p50"),
									)}
								>
									{metricP50LatencyMs === null ? "—" : formatLatency(metricP50LatencyMs)}
								</p>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">P95 Latency</span>
								<p
									className={cn(
										"text-xl font-semibold tabular-nums font-mono",
										metricP95LatencyMs === null
											? "text-muted-foreground"
											: // A p95 far above this node's own p50 is a tail problem
												// worth flagging even at a fine absolute magnitude.
												metricP50LatencyMs !== null &&
												  metricP95LatencyMs > metricP50LatencyMs * 3
												? "text-severity-warn"
												: latencyToneClass(metricP95LatencyMs, "p95"),
									)}
								>
									{metricP95LatencyMs === null ? "—" : formatLatency(metricP95LatencyMs)}
								</p>
							</div>
							<div className="space-y-0.5">
								<span className="text-[10px] text-muted-foreground">Avg Latency</span>
								<p
									className={cn(
										"text-xl font-semibold tabular-nums font-mono",
										latencyToneClass(metricAvgLatencyMs, "avg"),
									)}
								>
									{formatLatency(metricAvgLatencyMs)}
								</p>
							</div>
						</div>
					</div>

					{hyperdrive && hyperdrive.length > 0 ? <HyperdriveSection configs={hyperdrive} /> : null}

					{planetscale ? (
						<PlanetScaleSection
							planetscale={planetscale}
							startTime={startTime}
							endTime={endTime}
						/>
					) : null}

					<div className="space-y-3">
						<div className="h-px bg-border" />
						<div className="flex items-center justify-between gap-2">
							<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
								Query Activity
							</h4>
							{summaryWaiting && summaryResponse && (
								<span className="text-[10px] text-muted-foreground">Refreshing</span>
							)}
						</div>
						{Result.builder(summaryResult)
							.onError((error) => {
								const formatted = displayError(error)
								return (
									<div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs">
										<p className="font-medium text-destructive">{formatted.title}</p>
										<p className="mt-1 text-muted-foreground">{formatted.message}</p>
									</div>
								)
							})
							.orElse(() => null)}
						<DbQueryActivityChart response={summaryResponse} waiting={summaryWaiting} />
					</div>

					{summaryResponse?.topQueries.length ? (
						<div className="space-y-3">
							<div className="h-px bg-border" />
							<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
								Top Query Shapes
							</h4>
							<div className="space-y-1.5">
								{summaryResponse.topQueries.map((query) => (
									<div
										key={query.queryKey}
										className="rounded-md border border-border bg-card px-2.5 py-2"
									>
										<div className="flex items-start justify-between gap-2">
											<p className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground">
												{formatQueryLabel(query.queryLabel)}
											</p>
											<span
												className={cn(
													"shrink-0 font-mono text-[10px] tabular-nums",
													query.errorRate > 0.05
														? "text-severity-error"
														: query.errorRate > 0.01
															? "text-severity-warn"
															: "text-muted-foreground",
												)}
											>
												{(query.errorRate * 100).toFixed(1)}%
											</span>
										</div>
										<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
											<span className="font-mono tabular-nums">
												{query.estimatedQueryCount > query.queryCount + 1 ? "~" : ""}
												{formatCompactCount(query.estimatedQueryCount)} calls
											</span>
											<span className="font-mono tabular-nums">
												p50{" "}
												<span
													className={latencyToneClass(query.p50DurationMs, "p50")}
												>
													{formatLatency(query.p50DurationMs)}
												</span>
											</span>
											<span className="font-mono tabular-nums">
												p95{" "}
												<span
													className={latencyToneClass(query.p95DurationMs, "p95")}
												>
													{formatLatency(query.p95DurationMs)}
												</span>
											</span>
											<span className="truncate">
												{query.serviceCount > 1
													? `${query.serviceCount} services`
													: query.sampleService}
											</span>
										</div>
									</div>
								))}
							</div>
						</div>
					) : null}

					{callers.length > 0 && (
						<div className="space-y-3">
							<div className="h-px bg-border" />
							<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
								Called By
							</h4>
							<div className="space-y-1.5">
								{callers.map((caller) => {
									const callerColor = getServiceColor(caller.sourceService)
									const safeDuration = Math.max(durationSeconds, 1)
									const reqPerSec = caller.hasSampling
										? caller.estimatedCallCount / safeDuration
										: caller.callCount / safeDuration
									return (
										<div
											key={caller.sourceService}
											className="flex items-center justify-between px-2.5 py-2 rounded-md border bg-card border-border text-xs"
										>
											<div className="flex items-center gap-1.5 min-w-0">
												<div
													className="w-[3px] h-3.5 rounded-sm shrink-0"
													style={{ backgroundColor: callerColor }}
												/>
												<span className="text-foreground truncate">
													{caller.sourceService}
												</span>
											</div>
											<div className="flex items-center gap-2 shrink-0 text-[10px]">
												<span className="text-muted-foreground tabular-nums font-mono">
													{caller.hasSampling ? "~" : ""}
													{formatRate(reqPerSec)} calls/s
												</span>
												<span
													className={cn(
														"tabular-nums font-mono",
														caller.errorRate > 0.05
															? "text-severity-error"
															: caller.errorRate > 0.01
																? "text-severity-warn"
																: "text-severity-info",
													)}
												>
													{(caller.errorRate * 100).toFixed(1)}%
												</span>
											</div>
										</div>
									)
								})}
							</div>
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
	)
}

interface ServiceMapViewProps {
	viewMode?: "2d" | "3d"
	startTime: string
	endTime: string
	/** Deployment environment to scope the map to; `undefined` = all environments. */
	deploymentEnv?: string
	/** Controlled focus state (kept in the route's URL search params). */
	focus?: DeclutterFocus | null
	onFocusChange?: (focus: DeclutterFocus | null) => void
}

export function ServiceMapCanvas({
	viewMode = "2d",
	edges: serviceEdges,
	dbEdges,
	cloudflareServices,
	faasNames,
	planetscaleDatabases,
	planetscaleStats,
	hyperdriveConfigs,
	platforms,
	runtimes,
	overviews,
	workloads,
	durationSeconds,
	startTime,
	endTime,
	deploymentEnv,
	layoutKey,
	focus: focusProp,
	onFocusChange,
	minTrafficPctOverride,
}: {
	viewMode?: "2d" | "3d"
	edges: ServiceEdge[]
	dbEdges: ServiceDbEdge[]
	cloudflareServices: CloudflareService[]
	faasNames: Map<string, string>
	/** PlanetScale inventory: lowercased database name → identity (empty when not connected). */
	planetscaleDatabases: Map<
		string,
		{
			name: string
			kind: string
			branchCount: number
			branches: ReadonlyArray<{ name: string; production: boolean; ready: boolean }>
		}
	>
	/** PlanetScale scraped-metric rollups, one per database. */
	planetscaleStats: PlanetScaleDatabaseStat[]
	/** Cloudflare Hyperdrive config inventory (empty when not connected). */
	hyperdriveConfigs?: ReadonlyArray<HyperdriveConfigInput>
	platforms: Map<string, ServicePlatform>
	runtimes: Map<string, string>
	overviews: ServiceOverview[]
	workloads: ServiceWorkload[]
	durationSeconds: number
	startTime: string
	endTime: string
	/** Selected deployment environment (`undefined` = all); scopes the DB detail panel. */
	deploymentEnv?: string
	// Namespaces persisted drag positions / viewport. Lifted to a prop so the
	// component renders without a Clerk session (e.g. the /lab/bench/service-map
	// perf harness, which runs in self-hosted mode with no ClerkProvider).
	layoutKey: string
	/**
	 * Controlled focus (the route keeps it in URL search params). When omitted,
	 * focus falls back to local state (bench harness / embedding contexts).
	 */
	focus?: DeclutterFocus | null
	onFocusChange?: (focus: DeclutterFocus | null) => void
	/** Forces the low-traffic threshold, bypassing stored prefs (bench harness). */
	minTrafficPctOverride?: number
}) {
	const [layout, setLayout] = useAtom(serviceMapLayoutAtomFamily(layoutKey))
	const [viewPrefs, setViewPrefs] = useAtom(serviceMapViewPrefsAtomFamily(layoutKey))

	// Build nodes/edges (carrying live metrics) every render — cheap object work.
	const { rawNodes, flowEdges, services } = useMemo(() => {
		const { nodes, edges } = buildFlowElements({
			edges: serviceEdges,
			dbEdges,
			serviceOverviews: overviews,
			durationSeconds,
			serviceWorkloads: workloads,
			platforms,
			runtimes,
			cloudflareServices,
			faasNames,
			planetscaleDatabases,
			planetscaleStats,
			hyperdriveConfigs,
		})
		// Service legend / focus targets only include real services, not synthetic db: nodes
		const allServices = Array.from(
			new Set(nodes.filter((n) => !n.id.startsWith(DB_NODE_PREFIX)).map((n) => n.id)),
		).toSorted()
		return { rawNodes: nodes, flowEdges: edges, services: allServices }
	}, [
		serviceEdges,
		dbEdges,
		cloudflareServices,
		faasNames,
		planetscaleDatabases,
		planetscaleStats,
		hyperdriveConfigs,
		platforms,
		runtimes,
		overviews,
		workloads,
		durationSeconds,
	])

	// Cloudflare analytics overlaid onto instrumented Workers.
	const cloudflareOverlayByService = useMemo(() => {
		const m = new Map<string, CloudflareNodeMetrics>()
		for (const n of rawNodes) {
			if (n.data.cloudflare) m.set(n.id, n.data.cloudflare)
		}
		return m
	}, [rawNodes])

	// PlanetScale integration data overlaid onto matched DB nodes.
	const planetscaleOverlayByNode = useMemo(() => {
		const m = new Map<string, PlanetScaleNodeMetrics>()
		for (const n of rawNodes) {
			if (n.data.planetscale) m.set(n.id, n.data.planetscale)
		}
		return m
	}, [rawNodes])

	// Hyperdrive config resolution attached to the collapsed Hyperdrive node(s).
	const hyperdriveOverlayByNode = useMemo(() => {
		const m = new Map<string, ReadonlyArray<HyperdriveNodeInfo>>()
		for (const n of rawNodes) {
			if (n.data.hyperdrive) m.set(n.id, n.data.hyperdrive)
		}
		return m
	}, [rawNodes])

	const renderDetailPanel = ({ selectedId, colorMode, onClose, onFocus }: ServiceMapDetailPanelContext) =>
		selectedId.startsWith(DB_NODE_PREFIX) ? (
			<DatabaseDetailPanel
				{...parseDbNodeId(selectedId)}
				planetscale={planetscaleOverlayByNode.get(selectedId)}
				hyperdrive={hyperdriveOverlayByNode.get(selectedId)}
				dbEdges={dbEdges}
				durationSeconds={durationSeconds}
				startTime={startTime}
				endTime={endTime}
				deploymentEnv={deploymentEnv}
				onClose={onClose}
			/>
		) : (
			<ServiceDetailPanel
				serviceId={selectedId}
				edges={serviceEdges}
				overviews={overviews}
				workloads={workloads}
				platforms={platforms}
				colorMode={colorMode}
				cloudflare={cloudflareOverlayByService.get(selectedId)}
				durationSeconds={durationSeconds}
				onFocus={onFocus}
				onClose={onClose}
			/>
		)

	return (
		<ServiceMapFlowCanvas
			viewMode={viewMode}
			nodes={rawNodes}
			edges={flowEdges}
			services={services}
			layout={layout}
			onLayoutChange={setLayout}
			viewPrefs={viewPrefs}
			onViewPrefsChange={setViewPrefs}
			focus={focusProp}
			onFocusChange={onFocusChange}
			minTrafficPctOverride={minTrafficPctOverride}
			emptyState={<ServiceMapEmptyState />}
			renderDetailPanel={renderDetailPanel}
			render3D={renderLiveServiceMap3D}
			// Dev-only layout-spacing sliders, compiled out of production builds.
			showLayoutDebug={import.meta.env.DEV}
			onLayoutError={logClientError}
			onLayoutWarning={logClientWarning}
		/>
	)
}

export function ServiceMapView({
	viewMode = "2d",
	startTime,
	endTime,
	deploymentEnv,
	focus,
	onFocusChange,
}: ServiceMapViewProps) {
	const orgId = useMapleOrganizationId()
	const durationSeconds = useMemo(() => {
		const ms = new Date(endTime).getTime() - new Date(startTime).getTime()
		return Math.max(1, ms / 1000)
	}, [startTime, endTime])

	const mapInput: { data: GetServiceMapInput } = useMemo(
		() => ({ data: { startTime, endTime, deploymentEnv } }),
		[startTime, endTime, deploymentEnv],
	)

	// Cloudflare worker stats come from Cloudflare's own analytics (keyed by script,
	// with no Maple deployment.environment dimension), so they can't be env-scoped —
	// keep them on an env-less input so switching environments doesn't refetch the
	// same all-account data.
	const cloudflareInput: { data: GetServiceMapInput } = useMemo(
		() => ({ data: { startTime, endTime } }),
		[startTime, endTime],
	)

	const bundleResult = useRefreshableAtomValue(getServiceMapBundleResultAtom(mapInput))
	const cloudflareResult = useRefreshableAtomValue(getServiceMapCloudflareResultAtom(cloudflareInput))
	// PlanetScale scraped metrics carry no deployment.environment either — share
	// the env-less input so environment switches don't refetch.
	const planetscaleStatsResult = useRefreshableAtomValue(
		getServiceMapPlanetScaleResultAtom(cloudflareInput),
	)
	const planetscaleInventoryResult = useAtomValue(
		retainedQueryV2("planetscaleIntegration", "databases", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)
	const hyperdriveInventoryResult = useAtomValue(
		retainedQuery("integrations", "cloudflareHyperdrives", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)

	// Node DATA that streams in after the canvas mounts and refines nodes in place
	// (colors, icons, pod badges, detail-panel overlays) without moving them —
	// topology-determining results (edges, db edges, overviews) are gated below.
	const allOverviews = Result.isSuccess(bundleResult) ? bundleResult.value.overview : []

	// Client-side scoping for the org-global namespace pin: the bundle still
	// fetches every namespace (a server-side service.namespace filter is a
	// follow-up), so drop out-of-namespace services and everything that only
	// they touch. serviceNamespace is blanked because a map where every node
	// shares one namespace has nothing left to group.
	const pinnedNamespace = useGlobalNamespace()
	const memberServices = useMemo(() => {
		if (pinnedNamespace === null) return null
		return new Set(
			allOverviews.filter((o) => o.serviceNamespace === pinnedNamespace).map((o) => o.serviceName),
		)
	}, [pinnedNamespace, allOverviews])
	const overviews = useMemo(
		() =>
			memberServices === null
				? allOverviews
				: allOverviews
						.filter((o) => memberServices.has(o.serviceName))
						.map((o) => ({ ...o, serviceNamespace: "" })),
		[allOverviews, memberServices],
	)

	const allDbEdges = Result.isSuccess(bundleResult) ? bundleResult.value.dbEdges : []
	const dbEdges = useMemo(
		() =>
			memberServices === null
				? allDbEdges
				: allDbEdges.filter((edge) => memberServices.has(edge.sourceService)),
		[allDbEdges, memberServices],
	)
	const cloudflareServices = Result.isSuccess(cloudflareResult) ? cloudflareResult.value.services : []
	const planetscaleStats = Result.isSuccess(planetscaleStatsResult)
		? planetscaleStatsResult.value.databases
		: []
	const planetscaleDatabases = useMemo(() => {
		const map = new Map<
			string,
			{
				name: string
				kind: string
				branchCount: number
				branches: ReadonlyArray<{ name: string; production: boolean; ready: boolean }>
			}
		>()
		if (Result.isSuccess(planetscaleInventoryResult)) {
			for (const db of planetscaleInventoryResult.value.databases) {
				map.set(db.name.toLowerCase(), {
					name: db.name,
					kind: db.kind,
					branchCount: db.branches.length,
					branches: db.branches.map((branch) => ({
						name: branch.name,
						production: branch.production,
						ready: branch.ready,
					})),
				})
			}
		}
		return map
	}, [planetscaleInventoryResult])
	const hyperdriveConfigs = useMemo<ReadonlyArray<HyperdriveConfigInput>>(
		() =>
			Result.isSuccess(hyperdriveInventoryResult)
				? hyperdriveInventoryResult.value.configs.map((config) => ({
						id: config.id,
						name: config.name,
						originHost: config.originHost,
						originPort: config.originPort,
						originScheme: config.originScheme,
						originDatabase: config.originDatabase,
						originUser: config.originUser,
					}))
				: [],
		[hyperdriveInventoryResult],
	)
	const platforms = useMemo(() => {
		const map = new Map<string, ServicePlatform>()
		if (Result.isSuccess(bundleResult)) {
			for (const p of bundleResult.value.platforms) {
				map.set(p.serviceName, p.platform)
			}
		}
		return map
	}, [bundleResult])
	const runtimes = useMemo(() => {
		const map = new Map<string, string>()
		if (Result.isSuccess(bundleResult)) {
			for (const p of bundleResult.value.platforms) {
				if (p.runtime) map.set(p.serviceName, p.runtime)
			}
		}
		return map
	}, [bundleResult])
	// service.name → faas.name, so a `cloudflare-worker/{script}` from the direct
	// integration can be matched to (and overlaid onto) its instrumented node.
	const faasNames = useMemo(() => {
		const map = new Map<string, string>()
		if (Result.isSuccess(bundleResult)) {
			for (const p of bundleResult.value.platforms) {
				if (p.faasName) map.set(p.serviceName, p.faasName)
			}
		}
		return map
	}, [bundleResult])

	const allWorkloads = Result.isSuccess(bundleResult) ? bundleResult.value.workloads : []
	const workloads = useMemo(
		() =>
			memberServices === null
				? allWorkloads
				: allWorkloads.filter((workload) => memberServices.has(workload.serviceName)),
		[allWorkloads, memberServices],
	)

	return Result.builder(bundleResult)
		.onInitial(() => <ServiceMapLoading />)
		.onError((error) => {
			const formatted = displayError(error)
			return (
				<div className="flex items-center justify-center h-full">
					<div className="text-center space-y-2">
						<p className="text-sm font-medium text-destructive">{formatted.title}</p>
						<p className="text-xs text-muted-foreground">{formatted.message}</p>
					</div>
				</div>
			)
		})
		.onSuccess((mapResponse) => (
			<ServiceMapCanvas
				viewMode={viewMode}
				edges={
					memberServices === null
						? mapResponse.edges
						: mapResponse.edges.filter(
								(edge) =>
									memberServices.has(edge.sourceService) &&
									memberServices.has(edge.targetService),
							)
				}
				dbEdges={dbEdges}
				cloudflareServices={cloudflareServices}
				faasNames={faasNames}
				planetscaleDatabases={planetscaleDatabases}
				planetscaleStats={planetscaleStats}
				hyperdriveConfigs={hyperdriveConfigs}
				platforms={platforms}
				runtimes={runtimes}
				overviews={overviews}
				workloads={workloads}
				durationSeconds={durationSeconds}
				startTime={startTime}
				endTime={endTime}
				deploymentEnv={deploymentEnv}
				layoutKey={orgId ?? "default"}
				focus={focus}
				onFocusChange={onFocusChange}
			/>
		))
		.render()
}
