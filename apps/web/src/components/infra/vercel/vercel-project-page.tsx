// One Vercel project as a presentational page: header, stats, request charts, top paths and
// errors, deployments and AI Gateway usage. The route fetches; the lab renders it from fixtures.

import { useMemo, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type {
	VercelAiGatewayBucket,
	VercelAiGatewayResponse,
	VercelDeploymentSummary,
	VercelInfraProjectDetailResponse,
	VercelInfraRequestBucket,
	VercelProjectStatus,
} from "@maple/domain/http"
import { ChartLoading } from "@maple/ui/components/charts"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { ERROR_RATE_TEXT, errorRateLevel } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { CHART_HEIGHT, ChartCard } from "@/components/common/chart-card"
import { ColumnHead, DataTable } from "@/components/common/data-table"
import { HeroChip, PageHero } from "@/components/common/page-hero"
import { RelativeTime } from "@/components/common/relative-time"
import { SectionHeading } from "@/components/common/section-heading"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/common/stat-rail"
import { ExternalLinkIcon, FileIcon, PulseIcon } from "@/components/icons"
import { deploymentStateLabel, deploymentTone, percentOf } from "@/components/integrations/vercel-model"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { StackedBreakdownChart } from "../cloudflare/cloudflare-zone-detail-charts"
import { STATUS_CLASS_COLORS } from "../cloudflare/constants"
import { InfraMetricChart } from "../primitives/infra-metric-chart"
import {
	requestClassRows,
	vercelProjectLogAttrs,
	vercelProjectTracesWhere,
	type VercelProjectRow,
} from "./list-model"
import { VercelAiGatewayPanel } from "./vercel-ai-gateway"
import { DeploymentInline } from "./vercel-project-table"

const STATUS_ORDER = ["2xx", "3xx", "4xx", "5xx", "unknown"]
const ROW_CLASS = "flex items-center gap-4 border-b border-border/40 px-4 py-3 last:border-0"
const NUM = "text-right font-mono text-xs tabular-nums text-foreground/80"

const rate = (part: number, whole: number) => (percentOf(part, whole) ?? 0) / 100

function Stats({
	row,
	buckets,
}: {
	row: VercelProjectRow
	buckets: ReadonlyArray<VercelInfraRequestBucket>
}) {
	const errorFraction = row.errorPercent === null ? 0 : row.errorPercent / 100
	return (
		<StatRail columns={5}>
			<StatRailItem
				eyebrow="Requests"
				value={formatNumber(row.requests)}
				spark={buckets.map((bucket) => bucket.requests)}
				subline={
					row.lastSeen === null ? (
						"none in this window"
					) : (
						<RelativeTime value={row.lastSeen} prefix="last" />
					)
				}
			/>
			<StatRailItem
				eyebrow="5xx rate"
				value={row.errorPercent === null ? EMPTY_VALUE : formatErrorRate(errorFraction)}
				tone={errorRateLevel(errorFraction)}
				spark={buckets.map((bucket) => bucket.requests5xx)}
				subline={`${formatNumber(row.requests5xx)} server errors`}
			/>
			<StatRailItem
				eyebrow="Cache hits"
				value={row.cacheHitPercent === null ? EMPTY_VALUE : formatPercent(row.cacheHitPercent / 100)}
				spark={buckets.map((bucket) => bucket.cacheHits)}
				subline={row.cacheHitPercent === null ? "no cache lookups" : "of cache lookups"}
			/>
			<StatRailItem
				eyebrow="p95 latency"
				value={row.p95DurationMs === null ? EMPTY_VALUE : formatLatency(row.p95DurationMs)}
				compact
				subline={row.p95DurationMs === null ? "no deployment traces" : "deployment root spans"}
			/>
			<StatRailItem
				eyebrow="Error logs"
				value={formatNumber(row.errorLogs)}
				tone={row.errorLogs > 0 ? "warn" : "neutral"}
				spark={buckets.map((bucket) => bucket.errorLogs)}
				subline="error and fatal records"
			/>
		</StatRail>
	)
}

function Charts({ buckets }: { buckets: ReadonlyArray<VercelInfraRequestBucket> }) {
	const classes = useMemo(() => requestClassRows(buckets), [buckets])
	const xDomain = useMemo(() => buckets.map((bucket) => bucket.bucket), [buckets])
	const single = (pick: (bucket: VercelInfraRequestBucket) => number) =>
		buckets.map((bucket) => ({ bucket: bucket.bucket, attributeValue: "value", value: pick(bucket) }))
	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
			<div className="lg:col-span-2">
				<StackedBreakdownChart
					title="Requests by status"
					rows={classes}
					colors={STATUS_CLASS_COLORS}
					order={STATUS_ORDER}
				/>
			</div>
			<ChartCard title="Cache hits">
				<InfraMetricChart
					rows={single((bucket) => bucket.cacheHits)}
					unit="count"
					seriesLabel="Cache hits"
					xDomain={xDomain}
					height={CHART_HEIGHT}
				/>
			</ChartCard>
			<ChartCard title="Error logs">
				<InfraMetricChart
					rows={single((bucket) => bucket.errorLogs)}
					unit="count"
					seriesLabel="Error logs"
					xDomain={xDomain}
					seriesColors={{ value: "var(--severity-warn)" }}
					height={CHART_HEIGHT}
				/>
			</ChartCard>
		</div>
	)
}

function TopPaths({ paths }: { paths: VercelInfraProjectDetailResponse["paths"] }) {
	return (
		<section className="min-w-0 space-y-3">
			<SectionHeading title="Top paths" hint="most requested first" count={paths.length} />
			<DataTable.Root ariaLabel="Top paths">
				<DataTable.Head>
					<ColumnHead label="Path" width="w-0 flex-1 min-w-[160px]" />
					<ColumnHead label="Requests" width="w-[80px]" align="right" />
					<ColumnHead label="4xx" width="w-[64px]" align="right" hidden="hidden xl:flex" />
					<ColumnHead label="5xx" width="w-[64px]" align="right" />
					<ColumnHead label="Cached" width="w-[64px]" align="right" />
				</DataTable.Head>
				{paths.length === 0 ? (
					<DataTable.Empty>No requests in this window.</DataTable.Empty>
				) : (
					paths.map((path) => {
						const errors = rate(path.requests5xx, path.requests)
						return (
							<div key={path.path} className={ROW_CLASS}>
								<span
									className="w-0 min-w-[160px] flex-1 truncate font-mono text-xs text-foreground"
									title={path.path}
								>
									{path.path || "/"}
								</span>
								<span className={cn(NUM, "w-[80px]")}>{formatNumber(path.requests)}</span>
								<span className={cn(NUM, "hidden w-[64px] xl:block")}>
									{formatErrorRate(rate(path.requests4xx, path.requests))}
								</span>
								<span
									className={cn(NUM, "w-[64px]", ERROR_RATE_TEXT[errorRateLevel(errors)])}
								>
									{formatErrorRate(errors)}
								</span>
								<span className={cn(NUM, "w-[64px]")}>
									{path.cacheLookups === 0
										? EMPTY_VALUE
										: formatPercent(rate(path.cacheHits, path.cacheLookups))}
								</span>
							</div>
						)
					})
				)}
			</DataTable.Root>
		</section>
	)
}

function TopErrors({ errors }: { errors: VercelInfraProjectDetailResponse["errors"] }) {
	return (
		<section className="min-w-0 space-y-3">
			<SectionHeading
				title="Top errors"
				hint="error and fatal logs, most frequent first"
				count={errors.length}
			/>
			<DataTable.Root ariaLabel="Top errors">
				<DataTable.Head>
					<ColumnHead label="Message" width="w-0 flex-1 min-w-[200px]" />
					<ColumnHead label="Count" width="w-[64px]" align="right" />
					<ColumnHead label="Last seen" width="w-[72px]" align="right" />
				</DataTable.Head>
				{errors.length === 0 ? (
					<DataTable.Empty>No error logs in this window.</DataTable.Empty>
				) : (
					errors.map((error) => (
						<div key={`${error.source}:${error.message}`} className={ROW_CLASS}>
							<div className="flex w-0 min-w-[200px] flex-1 items-baseline gap-2">
								{error.source ? (
									<span className="shrink-0 rounded-sm bg-muted px-1 font-mono text-3xs text-muted-foreground">
										{error.source}
									</span>
								) : null}
								<span
									className="truncate font-mono text-xs text-foreground"
									title={error.message}
								>
									{error.message || "(empty message)"}
								</span>
							</div>
							<span className={cn(NUM, "w-[64px]", TONE_TEXT.crit)}>
								{formatNumber(error.occurrences)}
							</span>
							<span className="w-[72px] text-right">
								<RelativeTime
									value={error.lastSeen}
									variant="short"
									mono
									tooltip="title"
									className="text-2xs text-muted-foreground"
								/>
							</span>
						</div>
					))
				)}
			</DataTable.Root>
		</section>
	)
}

function Deployments({
	deployments,
	error,
}: {
	deployments: ReadonlyArray<VercelDeploymentSummary> | null
	error: ReactNode | undefined
}) {
	return (
		<section className="space-y-3">
			<SectionHeading
				title="Deployments"
				hint="newest first, from Vercel's API"
				count={deployments?.length}
			/>
			<DataTable.Root ariaLabel="Deployments">
				<DataTable.Head>
					<ColumnHead label="State" width="w-[104px]" />
					<ColumnHead label="Target" width="w-[88px]" hidden="hidden md:flex" />
					<ColumnHead label="Commit" width="w-0 flex-1 min-w-[260px]" />
					<ColumnHead label="By" width="w-[120px]" hidden="hidden lg:flex" />
					<ColumnHead label="Created" width="w-[72px]" align="right" />
					<ColumnHead label="" width="w-[16px]" />
				</DataTable.Head>
				{error !== undefined ? (
					error
				) : deployments === null ? (
					<DataTable.SkeletonRows count={3}>
						<Skeleton className="h-3 w-full" />
					</DataTable.SkeletonRows>
				) : deployments.length === 0 ? (
					<DataTable.Empty>
						No deployments recorded yet. Maple reads them from Vercel every few minutes.
					</DataTable.Empty>
				) : (
					deployments.map((deployment) => (
						<div key={deployment.id} className={ROW_CLASS}>
							<span className="flex w-[104px] items-center gap-1.5 text-xs">
								<StatusDot tone={deploymentTone(deployment.state)} size="lg" />
								{deploymentStateLabel(deployment.state)}
							</span>
							<span className="hidden w-[88px] text-2xs text-muted-foreground md:block">
								{deployment.target ?? "preview"}
							</span>
							<span className="flex w-0 min-w-[260px] flex-1 items-baseline gap-2">
								{deployment.branch ? (
									<span className="max-w-[40%] shrink-0 truncate font-mono text-2xs text-foreground/80">
										{deployment.branch}
									</span>
								) : null}
								<span
									className="truncate text-xs text-foreground"
									title={deployment.commitMessage ?? undefined}
								>
									{deployment.commitMessage?.split("\n")[0] ?? deployment.url}
								</span>
								{deployment.commitSha ? (
									<span className="shrink-0 font-mono text-3xs text-muted-foreground">
										{deployment.commitSha.slice(0, 7)}
									</span>
								) : null}
							</span>
							<span className="hidden w-[120px] truncate text-2xs text-muted-foreground lg:block">
								{deployment.creator ?? EMPTY_VALUE}
							</span>
							<span className="w-[72px] text-right">
								<RelativeTime
									value={deployment.createdAt}
									variant="short"
									mono
									tooltip="title"
									className="text-2xs text-muted-foreground"
								/>
							</span>
							<span className="flex w-[16px] justify-end">
								{deployment.inspectorUrl ? (
									<a
										href={deployment.inspectorUrl}
										target="_blank"
										rel="noopener noreferrer"
										aria-label="Open in Vercel"
										title="Open in Vercel"
										className="text-muted-foreground hover:text-foreground"
									>
										<ExternalLinkIcon size={12} />
									</a>
								) : null}
							</span>
						</div>
					))
				)}
			</DataTable.Root>
		</section>
	)
}

export function VercelProjectPage({
	projectId,
	project,
	row,
	buckets,
	detail,
	deployments,
	deploymentsError,
	aiGateway,
	aiTimeseries,
	error,
	detailError,
	aiGatewayError,
	timeSearch,
}: {
	projectId: string
	/** The inventory's view of the project; null when it is not listed. */
	project: VercelProjectStatus | null
	/** Null while loading. */
	row: VercelProjectRow | null
	/** Gaps filled; null while loading. */
	buckets: ReadonlyArray<VercelInfraRequestBucket> | null
	detail: VercelInfraProjectDetailResponse | null
	deployments: ReadonlyArray<VercelDeploymentSummary> | null
	/** Replaces the deployment rows when their read failed. */
	deploymentsError?: ReactNode
	aiGateway: VercelAiGatewayResponse | null
	aiTimeseries: ReadonlyArray<VercelAiGatewayBucket>
	/** Replaces the stats and charts when their warehouse reads failed. */
	error?: ReactNode
	/** Replaces the top paths and errors when their read failed. */
	detailError?: ReactNode
	/** Replaces the AI Gateway section when its read failed. */
	aiGatewayError?: ReactNode
	timeSearch: TimeRangeSearch
}) {
	const production = project?.productionDeployment ?? null
	const noNames = useMemo(() => new Map<string, string>(), [])
	return (
		<div className="space-y-6">
			<PageHero
				title={project?.name ?? row?.name ?? projectId}
				trailing={project?.framework ? <HeroChip>{project.framework}</HeroChip> : null}
				meta={
					production === null ? (
						<span className="text-2xs text-muted-foreground">
							No production deployment recorded
						</span>
					) : (
						<>
							<span className="text-2xs text-muted-foreground">Production</span>
							<DeploymentInline deployment={production} />
							<a
								href={`https://${production.url}`}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 font-mono text-2xs text-muted-foreground hover:text-foreground"
							>
								{production.url}
								<ExternalLinkIcon size={10} />
							</a>
						</>
					)
				}
				actions={
					<>
						<Button
							size="sm"
							variant="outline"
							render={
								<Link
									to="/logs"
									search={{ ...timeSearch, attrs: [...vercelProjectLogAttrs(projectId)] }}
								/>
							}
						>
							<FileIcon />
							Logs
						</Button>
						<Button
							size="sm"
							variant="outline"
							render={
								<Link
									to="/traces"
									search={{
										...timeSearch,
										whereClause: vercelProjectTracesWhere(projectId),
									}}
								/>
							}
						>
							<PulseIcon />
							Traces
						</Button>
					</>
				}
			/>
			{error ??
				(row === null || buckets === null ? (
					<>
						<StatRailLoading count={5} columns={5} />
						<div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
							<ChartLoading variant="area" height={CHART_HEIGHT} className="lg:col-span-2" />
							<ChartLoading variant="area" height={CHART_HEIGHT} />
							<ChartLoading variant="area" height={CHART_HEIGHT} />
						</div>
					</>
				) : (
					<>
						<Stats row={row} buckets={buckets} />
						<Charts buckets={buckets} />
					</>
				))}
			{detailError ??
				(detail === null ? null : (
					<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
						<TopPaths paths={detail.paths} />
						<TopErrors errors={detail.errors} />
					</div>
				))}
			<Deployments deployments={deployments} error={deploymentsError} />
			{aiGatewayError !== undefined ? (
				<section className="space-y-3">
					<SectionHeading
						title="AI Gateway"
						hint="requests this project made through Vercel AI Gateway"
					/>
					{aiGatewayError}
				</section>
			) : aiGateway !== null && aiGateway.summary.requests > 0 ? (
				<section className="space-y-3">
					<SectionHeading
						title="AI Gateway"
						hint="requests this project made through Vercel AI Gateway"
					/>
					<VercelAiGatewayPanel
						data={aiGateway}
						timeseries={aiTimeseries}
						projectNames={noNames}
						timeSearch={timeSearch}
					/>
				</section>
			) : null}
		</div>
	)
}
