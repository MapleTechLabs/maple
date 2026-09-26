// Side panel for the selected service-map node. Same vocabulary as the cloud
// app's panel (accent stripe, health dot, metric tiles, caller/callee rows),
// minus the cloud-only integrations; links go to the local service and trace pages.

import type { ReactNode } from "react"
import type { ServiceOverview } from "@maple/query-engine"
import { MagnifierIcon, XmarkIcon } from "@maple/ui/components/icons"
import { Button } from "@maple/ui/components/ui/button"
import { ScrollArea } from "@maple/ui/components/ui/scroll-area"
import { formatLatency } from "@maple/ui/lib/format"
import { getServiceColor } from "@maple/ui/lib/colors"
import { latencyToneClass } from "@maple/ui/lib/latency-tone"
import { cn } from "@maple/ui/lib/utils"
import { resolveDbNodePresentation, withAlpha } from "@maple/ui/components/service-map/service-map-db"
import {
	dbNodeId,
	getServiceMapNodeColor,
	type ServiceMapColorMode,
} from "@maple/ui/components/service-map/service-map-utils"
import type {
	ServiceMapDbEdgeRow,
	ServiceMapEdgeRow,
	ServicePlatform,
} from "@maple/ui/components/service-map/service-map-types"
import { hrefFor } from "../lib/router"

function formatRate(value: number): string {
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
	if (value >= 1) return value.toFixed(1)
	return value.toFixed(2)
}

const formatErrorPct = (rate: number) => `${(rate * 100).toFixed(1)}%`

function healthDotClass(errorRate: number): string {
	if (errorRate > 0.05) return "bg-severity-error"
	if (errorRate > 0.01) return "bg-severity-warn"
	return "bg-severity-info"
}

function errorToneClass(errorRate: number, calm = "text-foreground"): string {
	if (errorRate > 0.05) return "text-severity-error"
	if (errorRate > 0.01) return "text-severity-warn"
	return calm
}

export function serviceHref(serviceName: string, range: string): string {
	return hrefFor(`/services/${encodeURIComponent(serviceName)}`, new URLSearchParams({ range }))
}

/** Span scope: most services never own a trace's root span. */
export function serviceTracesHref(serviceName: string, range: string): string {
	return hrefFor("/traces", new URLSearchParams({ scope: "spans", service: serviceName, range }))
}

function PanelHeader({
	accentColor,
	errorRate,
	title,
	subtitle,
	children,
}: {
	accentColor: string
	errorRate: number
	title: string
	subtitle?: ReactNode
	children: ReactNode
}) {
	return (
		<div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
			<div className="flex min-w-0 items-center gap-2">
				<div
					className="h-[18px] w-[3px] shrink-0 rounded-sm"
					style={{ backgroundColor: accentColor }}
				/>
				<div className={cn("size-1.5 shrink-0 rounded-full", healthDotClass(errorRate))} />
				<div className="flex min-w-0 flex-col">
					<span className="truncate text-sm font-semibold text-foreground">{title}</span>
					{subtitle ? (
						<span className="truncate text-[10px] text-muted-foreground">{subtitle}</span>
					) : null}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1">{children}</div>
		</div>
	)
}

function SectionTitle({ children }: { children: ReactNode }) {
	return (
		<h4 className="text-[10px] font-medium tracking-widest text-muted-foreground/60 uppercase">
			{children}
		</h4>
	)
}

function MetricTile({
	label,
	value,
	unit,
	className,
	title,
}: {
	label: string
	value: string
	unit?: string
	className?: string
	title?: string
}) {
	return (
		<div className="space-y-0.5" title={title}>
			<span className="text-[10px] text-muted-foreground">{label}</span>
			<p className={cn("font-mono text-xl font-semibold tabular-nums text-foreground", className)}>
				{value}
			</p>
			{unit ? <span className="text-[10px] text-muted-foreground">{unit}</span> : null}
		</div>
	)
}

interface PeerRow {
	key: string
	label: string
	color: string
	href?: string
	reqPerSec: number
	tracedReqPerSec: number
	errorRate: number
	hasSampling: boolean
	samplingWeight: number
}

function PeerList({ title, rows }: { title: string; rows: ReadonlyArray<PeerRow> }) {
	if (rows.length === 0) return null
	return (
		<div className="space-y-3">
			<div className="h-px bg-border" />
			<SectionTitle>{title}</SectionTitle>
			<div className="space-y-1.5">
				{rows.map((row) => {
					const name = (
						<span className="flex min-w-0 items-center gap-1.5">
							<span
								className="h-3.5 w-[3px] shrink-0 rounded-sm"
								style={{ backgroundColor: row.color }}
							/>
							<span className="truncate text-foreground">{row.label}</span>
						</span>
					)
					return (
						<div
							key={row.key}
							className={cn(
								"flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs",
								row.errorRate > 0.05
									? "border-severity-error/[0.12] bg-severity-error/[0.04]"
									: "border-border bg-card",
							)}
							title={
								row.hasSampling
									? `Estimated x${row.samplingWeight.toFixed(0)} from ${formatRate(row.tracedReqPerSec)} traced req/s`
									: undefined
							}
						>
							{row.href ? (
								<a href={row.href} className="min-w-0 hover:underline">
									{name}
								</a>
							) : (
								name
							)}
							<span className="flex shrink-0 items-center gap-2 text-[10px]">
								<span className="font-mono tabular-nums text-muted-foreground">
									{row.hasSampling ? "~" : ""}
									{formatRate(row.reqPerSec)} req/s
								</span>
								<span
									className={cn(
										"font-mono tabular-nums",
										errorToneClass(row.errorRate, "text-severity-info"),
									)}
								>
									{formatErrorPct(row.errorRate)}
								</span>
							</span>
						</div>
					)
				})}
			</div>
		</div>
	)
}

type EdgeLike = Pick<
	ServiceMapEdgeRow,
	"callCount" | "estimatedCallCount" | "errorRate" | "hasSampling" | "samplingWeight"
>

function rates(edge: EdgeLike, durationSeconds: number) {
	const safe = Math.max(durationSeconds, 1)
	return {
		reqPerSec: (edge.hasSampling ? edge.estimatedCallCount : edge.callCount) / safe,
		tracedReqPerSec: edge.callCount / safe,
		errorRate: edge.errorRate,
		hasSampling: edge.hasSampling,
		samplingWeight: edge.samplingWeight,
	}
}

export function ServiceMapServicePanel({
	serviceName,
	overviews,
	edges,
	dbEdges,
	platform,
	colorMode,
	durationSeconds,
	range,
	onFocus,
	onClose,
}: {
	serviceName: string
	overviews: ReadonlyArray<ServiceOverview>
	edges: ReadonlyArray<ServiceMapEdgeRow>
	dbEdges: ReadonlyArray<ServiceMapDbEdgeRow>
	platform: ServicePlatform | undefined
	colorMode: ServiceMapColorMode
	durationSeconds: number
	range: string
	onFocus: () => void
	onClose: () => void
}) {
	// Several environments can report one service; the map node uses the busiest row too.
	const overview = overviews
		.filter((o) => o.serviceName === serviceName)
		.reduce<ServiceOverview | undefined>(
			(best, o) => (!best || o.throughput > best.throughput ? o : best),
			undefined,
		)
	const errorRate = overview?.errorRate ?? 0
	const p50 = overview?.p50LatencyMs ?? 0
	const p95 = overview?.p95LatencyMs ?? 0
	const accentColor = getServiceMapNodeColor(
		{ label: serviceName, kind: "service", errorRate, platform },
		colorMode,
	)

	const calls: PeerRow[] = edges
		.filter((e) => e.sourceService === serviceName)
		.map((e) => ({
			key: e.targetService,
			label: e.targetService,
			color: getServiceColor(e.targetService),
			href: serviceHref(e.targetService, range),
			...rates(e, durationSeconds),
		}))
	const databases: PeerRow[] = dbEdges
		.filter((e) => e.sourceService === serviceName)
		.map((e) => {
			const db = resolveDbNodePresentation(e.dbSystem, e.dbNamespace)
			return {
				key: dbNodeId(e.dbSystem, e.dbNamespace),
				label: db.title,
				color: db.color,
				...rates(e, durationSeconds),
			}
		})
	const calledBy: PeerRow[] = edges
		.filter((e) => e.targetService === serviceName)
		.map((e) => ({
			key: e.sourceService,
			label: e.sourceService,
			color: getServiceColor(e.sourceService),
			href: serviceHref(e.sourceService, range),
			...rates(e, durationSeconds),
		}))

	return (
		<div className="flex h-full flex-col overflow-hidden bg-background">
			<PanelHeader
				accentColor={accentColor}
				errorRate={errorRate}
				title={serviceName}
				subtitle={overview?.serviceNamespace || undefined}
			>
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={onFocus}
					title="Focus the map on this service's neighborhood"
				>
					<MagnifierIcon size={13} />
				</Button>
				<Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close panel">
					<XmarkIcon size={14} />
				</Button>
			</PanelHeader>

			<ScrollArea className="min-h-0 flex-1">
				<div className="space-y-5 p-4">
					<div className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							size="sm"
							render={<a href={serviceHref(serviceName, range)} />}
						>
							View service
						</Button>
						<Button
							variant="outline"
							size="sm"
							render={<a href={serviceTracesHref(serviceName, range)} />}
						>
							View traces
						</Button>
					</div>

					<div className="space-y-3">
						<SectionTitle>Metrics</SectionTitle>
						<div className="grid grid-cols-2 gap-x-6 gap-y-4">
							<MetricTile
								label="Throughput"
								value={`${overview?.hasSampling ? "~" : ""}${formatRate(overview?.throughput ?? 0)}`}
								unit="req/s"
							/>
							<MetricTile
								label="Error Rate"
								value={formatErrorPct(errorRate)}
								className={errorToneClass(errorRate)}
							/>
							<MetricTile
								label="P50 Latency"
								value={formatLatency(p50)}
								className={latencyToneClass(p50, "p50")}
							/>
							<MetricTile
								label="P95 Latency"
								value={formatLatency(p95)}
								// A p95 far above the service's own p50 is a tail problem worth flagging.
								className={
									p95 > p50 * 3 ? "text-severity-warn" : latencyToneClass(p95, "p95")
								}
							/>
						</div>
					</div>

					<PeerList title="Calls" rows={calls} />
					<PeerList title="Databases" rows={databases} />
					<PeerList title="Called by" rows={calledBy} />
				</div>
			</ScrollArea>
		</div>
	)
}

export function ServiceMapDatabasePanel({
	dbSystem,
	dbNamespace,
	dbEdges,
	durationSeconds,
	range,
	onClose,
}: {
	dbSystem: string
	dbNamespace: string
	dbEdges: ReadonlyArray<ServiceMapDbEdgeRow>
	durationSeconds: number
	range: string
	onClose: () => void
}) {
	const callers = dbEdges.filter((e) => e.dbSystem === dbSystem && e.dbNamespace === dbNamespace)
	const totalCalls = callers.reduce((sum, e) => sum + e.callCount, 0)
	const totalErrors = callers.reduce((sum, e) => sum + e.errorCount, 0)
	const estimatedCalls = callers.reduce((sum, e) => sum + e.estimatedCallCount, 0)
	const errorRate = totalCalls > 0 ? totalErrors / totalCalls : 0
	const avgLatencyMs =
		totalCalls > 0 ? callers.reduce((sum, e) => sum + e.avgDurationMs * e.callCount, 0) / totalCalls : 0
	// The worst caller's p95 (a real p95); the max stands in, labelled as one, when no digest exists.
	const p95 = callers.reduce((worst, e) => Math.max(worst, e.p95DurationMs), 0)
	const max = callers.reduce((worst, e) => Math.max(worst, e.maxDurationMs), 0)
	const hasSampling = callers.some((e) => e.hasSampling)
	const db = resolveDbNodePresentation(dbSystem, dbNamespace)
	const DbIcon = db.Icon

	const calledBy: PeerRow[] = callers.map((e) => ({
		key: e.sourceService,
		label: e.sourceService,
		color: getServiceColor(e.sourceService),
		href: serviceHref(e.sourceService, range),
		...rates(e, durationSeconds),
	}))

	return (
		<div className="flex h-full flex-col overflow-hidden bg-background">
			<PanelHeader
				accentColor={db.color}
				errorRate={errorRate}
				title={db.title}
				subtitle={
					<span className="flex items-center gap-1">
						<span
							className="inline-flex size-3.5 items-center justify-center rounded-sm"
							style={{ backgroundColor: withAlpha(db.color, 0.16), color: db.color }}
						>
							<DbIcon size={10} />
						</span>
						{db.systemLabel}
					</span>
				}
			>
				<Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close panel">
					<XmarkIcon size={14} />
				</Button>
			</PanelHeader>

			<ScrollArea className="min-h-0 flex-1">
				<div className="space-y-5 p-4">
					<div className="space-y-3">
						<SectionTitle>Metrics</SectionTitle>
						<div className="grid grid-cols-2 gap-x-6 gap-y-4">
							<MetricTile
								label="Calls"
								value={`${hasSampling ? "~" : ""}${formatRate(estimatedCalls / Math.max(durationSeconds, 1))}`}
								unit="calls/s"
							/>
							<MetricTile
								label="Error Rate"
								value={formatErrorPct(errorRate)}
								className={errorToneClass(errorRate)}
							/>
							<MetricTile
								label="Avg Latency"
								value={formatLatency(avgLatencyMs)}
								className={latencyToneClass(avgLatencyMs, "avg")}
							/>
							{p95 > 0 ? (
								<MetricTile
									label="P95 Latency"
									value={formatLatency(p95)}
									className={latencyToneClass(p95, "p95")}
								/>
							) : (
								<MetricTile
									label="Max Latency"
									value={formatLatency(max)}
									title="Slowest call in the window"
								/>
							)}
						</div>
					</div>

					<PeerList title="Called by" rows={calledBy} />
				</div>
			</ScrollArea>
		</div>
	)
}
