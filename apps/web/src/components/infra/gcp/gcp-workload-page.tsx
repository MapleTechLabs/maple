// A Google Cloud workload's detail page, its parts. Presentational: the route fetches, the lab
// feeds fixtures.

import { useMemo, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"

import { GCP_INFRA_SERVICES, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { formatWarehouseDateTime } from "@maple/query-engine/datetime"
import type { ErrorRateLevel } from "@maple/ui/lib/error-rate"
import { formatLatency, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { HeroChip, PageHero } from "@/components/common/page-hero"
import { SectionHeading } from "@/components/common/section-heading"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimeInTimezone } from "@/lib/timezone-format"

import { CorrelationStrips, type StripSeries } from "../service-lens/correlation-strips"
import { GCP_INFRA_CHARTS, type GcpBucketPoint, type GcpChartWindow } from "./charts"
import {
	gcpPoolFull,
	gcpSqlEngine,
	gcpSqlSize,
	type GcpAppWait,
	type GcpConnectionPeak,
} from "./cloud-sql-signals"
import { GcpServiceIcon } from "./gcp-service-icon"
import { GcpWorkloadCharts } from "./gcp-workload-charts"
import type { GcpCloudSqlInstance } from "./inventory"
import { gcpWorkloadName } from "./tabs"
import { gcpStripDomain, gcpWorkloadStrips, type GcpStripSummary, type GcpTraceGap } from "./workload-signals"

/** What a workload is, in the hero's first chip. */
const SERVICE_KIND = {
	cloudRun: "cloud run",
	cloudFunctions: "function 1st gen",
	gke: "gke container",
	computeEngine: "vm instance",
	cloudSql: "cloud sql",
	pubsub: "pub/sub subscription",
	loadBalancing: "load balancer",
} satisfies Record<GcpInfraServiceId, string>

const HEALTH_DOT = {
	crit: "bg-severity-error",
	warn: "bg-severity-warn",
	neutral: "bg-severity-info",
} satisfies Record<ErrorRateLevel, string>

/** Where a workload runs is its name alone; every other identity value says what it is. */
const BARE_IDENTITY = ["Region", "Zone", "Location"]
/** The rail lists the project. */
const RAIL_IDENTITY = ["Project"]

export function GcpWorkloadHeader({
	service,
	keys,
	health,
	databaseVersion,
	meta,
}: {
	service: GcpInfraServiceId
	keys: ReadonlyArray<string>
	/** Null while the workload has no metrics in the window. */
	health: ErrorRateLevel | null
	/** A Cloud SQL instance's engine, for its logo; undefined until the inventory answers. */
	databaseVersion?: string | null
	/** Chips in place of the identity's: a Cloud SQL instance's say what it runs. */
	meta?: ReactNode
}) {
	return (
		<PageHero
			title={
				<span className="flex items-center gap-3">
					<span className="relative">
						<GcpServiceIcon service={service} databaseVersion={databaseVersion} size="lg" />
						{health === null ? null : (
							<span
								aria-hidden
								className={cn(
									"absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
									HEALTH_DOT[health],
								)}
							/>
						)}
					</span>
					<span className="font-mono">{gcpWorkloadName(service, keys)}</span>
				</span>
			}
			meta={
				meta ?? (
					<>
						<HeroChip>{SERVICE_KIND[service]}</HeroChip>
						{GCP_INFRA_SERVICES[service].identity.slice(1).map(([label], index) => {
							const value = keys[index + 1]
							if (!value || RAIL_IDENTITY.includes(label)) return null
							return (
								<HeroChip key={label}>
									{BARE_IDENTITY.includes(label)
										? value
										: `${label.toLowerCase()} ${value}`}
								</HeroChip>
							)
						})}
					</>
				)
			}
		/>
	)
}

/** A Cloud SQL instance's chips: its engine, the services that query it, and its shape. */
export function GcpCloudSqlChips({
	keys,
	instance,
	databaseVersion,
	services,
}: {
	keys: ReadonlyArray<string>
	/** Undefined until the inventory answers, or for an instance it does not list. */
	instance: GcpCloudSqlInstance | undefined
	/** The instance's engine: the inventory's, else what its metrics give away. */
	databaseVersion: string | undefined
	/** How many traced services query its databases; undefined while unknown. */
	services: number | undefined
}) {
	const engine = gcpSqlEngine(databaseVersion ?? null)
	const machine = [
		keys[2] || undefined,
		instance === undefined ? undefined : gcpSqlSize(instance),
		instance?.availabilityType === "REGIONAL" ? "HA" : undefined,
	].filter((part) => part !== undefined)
	return (
		<>
			<HeroChip>{engine?.toLowerCase() ?? SERVICE_KIND.cloudSql}</HeroChip>
			{services === undefined || services === 0 ? null : (
				<HeroChip>
					queried by {services} {services === 1 ? "service" : "services"}
				</HeroChip>
			)}
			{machine.length === 0 ? null : <HeroChip>{machine.join(" · ")}</HeroChip>}
		</>
	)
}

/**
 * Only rendered when a statement's app-side p95 is far over its database-side p95: the time went
 * outside the database. Full connections name the pool as where it went.
 */
export function GcpAppWaitCallout({
	wait,
	peak,
	instanceName,
	timeSearch,
}: {
	wait: GcpAppWait
	peak: GcpConnectionPeak | undefined
	instanceName: string
	timeSearch: TimeRangeSearch
}) {
	const idle = Math.round(peak?.idleInTransaction ?? 0)
	const why =
		peak !== undefined && peak.max !== null && gcpPoolFull(peak)
			? `The gap is waiting for a connection: ${instanceName} sat at ${Math.round(peak.open)} of ${peak.max}${idle > 0 ? `, and ${idle} of them were idle in transaction` : ""}. Fix the pool, not the query.`
			: "The time is spent outside the database: the network, or waiting on the connection pool."
	return (
		<div className="@container rounded-lg border border-severity-error/40">
			<div className="flex flex-col @2xl:flex-row @2xl:items-center">
				<div className="min-w-0 flex-1 space-y-1 px-4 py-3">
					<p className="text-sm font-medium text-foreground">
						{wait.service} waits {formatLatency(wait.appP95Ms)} for a query the database runs in{" "}
						{formatLatency(wait.dbP95Ms)}
					</p>
					<p className="truncate font-mono text-2xs text-muted-foreground" title={wait.statement}>
						{wait.statement}
					</p>
					<p className="max-w-prose text-xs text-muted-foreground">
						Same statement, p95 from both ends. {why}
					</p>
				</div>
				<div className="flex items-center gap-6 border-t px-4 py-3 @2xl:self-stretch @2xl:border-t-0 @2xl:border-l @2xl:px-5">
					<Figure
						value={formatLatency(wait.appP95Ms)}
						caption="app p95"
						className="text-severity-error"
					/>
					<Figure value={formatLatency(wait.dbP95Ms)} caption="database" />
					<Link
						to="/traces"
						search={{
							...timeSearch,
							services: [wait.service],
							minDurationMs: Math.round(wait.appP95Ms),
						}}
						className="ml-auto font-mono text-xs text-primary hover:text-primary/80 @2xl:ml-0"
					>
						Slow traces
					</Link>
				</div>
			</div>
		</div>
	)
}

const GAP_COPY = {
	cloudRun: {
		counted: "5xx Cloud Run returned",
		platform: "Cloud Run",
		why: (name: string) =>
			`Cloud Run answered them before ${name}'s code ran: its own 503 when no instance was free, or a request timeout.`,
	},
	cloudFunctions: {
		counted: "failed executions Cloud Functions counted",
		platform: "Cloud Functions",
		why: (name: string) =>
			`They most likely failed before ${name} exported a span: a timeout, a crash, or memory running out.`,
	},
}

/** Only rendered when Google counted clearly more server errors than the workload's spans did. */
export function GcpTraceGapCallout({
	service,
	gap,
	tracedService,
	logsService,
}: {
	service: "cloudRun" | "cloudFunctions"
	gap: GcpTraceGap
	tracedService: string
	logsService: string
}) {
	const { effectiveTimezone } = useTimezonePreference()
	const copy = GAP_COPY[service]
	const time = (ms: number) => formatTimeInTimezone(ms, { timeZone: effectiveTimezone })
	return (
		<div className="@container rounded-lg border border-severity-error/40">
			<div className="flex flex-col @2xl:flex-row @2xl:items-center">
				<div className="flex-1 space-y-1 px-4 py-3">
					<p className="text-sm font-medium text-foreground">
						{formatNumber(gap.platformErrors)} {copy.counted},{" "}
						{gap.tracedErrors === 0 ? "none" : formatNumber(gap.tracedErrors)} in your traces
					</p>
					<p className="max-w-prose text-xs text-muted-foreground">
						The other {formatNumber(gap.platformErrors - gap.tracedErrors)} came back{" "}
						{time(gap.fromMs)}–{time(gap.untilMs)}
						{gap.peakInstances === undefined
							? ""
							: ` while instances were at their peak of ${gap.peakInstances}`}
						. {copy.why(tracedService)}
					</p>
				</div>
				<div className="flex items-center gap-6 border-t px-4 py-3 @2xl:self-stretch @2xl:border-t-0 @2xl:border-l @2xl:px-5">
					<Figure
						value={formatNumber(gap.platformErrors)}
						caption={copy.platform}
						className="text-severity-error"
					/>
					<Figure value={formatNumber(gap.tracedErrors)} caption="traces" />
					<Link
						to="/logs"
						search={{
							services: [logsService],
							startTime: formatWarehouseDateTime(gap.fromMs),
							endTime: formatWarehouseDateTime(gap.untilMs),
						}}
						className="ml-auto font-mono text-xs text-primary hover:text-primary/80 @2xl:ml-0"
					>
						Logs at those times
					</Link>
				</div>
			</div>
		</div>
	)
}

function Figure({ value, caption, className }: { value: string; caption: string; className?: string }) {
	return (
		<div className="flex flex-col items-start @2xl:items-end">
			<span className={cn("font-mono text-sm font-semibold tabular-nums text-foreground", className)}>
				{value}
			</span>
			<span className="font-mono text-3xs text-muted-foreground">{caption}</span>
		</div>
	)
}

/**
 * The signals that explain each other, on one time axis under one cursor, then every chart of
 * the service so nothing the strips leave out is lost. Those link into the metrics explorer.
 */
export function GcpWorkloadSignals({
	service,
	points,
	range,
	where,
	timeSearch,
	maxConnections = null,
	children,
}: {
	service: GcpInfraServiceId
	points: ReadonlyArray<GcpBucketPoint>
	range: GcpChartWindow
	/** The metrics explorer filter that selects this workload's series. */
	where: string
	timeSearch: TimeRangeSearch
	/** A Cloud SQL instance's `max_connections`, for its connections strip. */
	maxConnections?: number | null
	/** Between the strips and every chart: what explains the strips. */
	children?: ReactNode
}) {
	const { startTime, endTime, bucketSeconds } = range
	const series = useMemo(
		() =>
			gcpWorkloadStrips(service, points, { startTime, endTime, bucketSeconds }, maxConnections).map(
				(strip): StripSeries => ({
					id: `gcp-${strip.id}`,
					label: strip.label,
					source: strip.source,
					rows: strip.rows,
					unit: strip.unit,
					showThreshold: strip.threshold,
					colors: strip.colors,
					summary: <Summary summary={strip.summary} />,
				}),
			),
		[service, points, startTime, endTime, bucketSeconds, maxConnections],
	)
	const xDomain = useMemo(() => gcpStripDomain(points, bucketSeconds), [points, bucketSeconds])
	return (
		<div className="space-y-6">
			<CorrelationStrips series={series} xDomain={xDomain} />
			{children}
			<section className="space-y-3">
				<SectionHeading title="All charts" hint="each opens in the metrics explorer" />
				<GcpWorkloadCharts
					charts={GCP_INFRA_CHARTS[service]}
					points={points}
					range={range}
					where={where}
					timeSearch={timeSearch}
				/>
			</section>
		</div>
	)
}

function Summary({ summary }: { summary: GcpStripSummary }) {
	return (
		<>
			<span
				className={cn(
					"font-mono text-sm font-semibold tabular-nums text-foreground",
					summary.alert && "text-severity-error",
				)}
			>
				{summary.value}
			</span>
			{summary.caption === undefined ? null : (
				<span className="font-mono text-3xs text-muted-foreground">{summary.caption}</span>
			)}
		</>
	)
}
