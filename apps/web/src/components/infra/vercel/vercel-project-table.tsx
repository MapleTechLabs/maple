import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import type {
	VercelAiGatewaySummary,
	VercelDeploymentSummary,
	VercelInfraRequestBucket,
} from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
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

import {
	ColumnHead,
	DataTable,
	ROW_LINK_CLASS,
	type SortControls,
	useTableSort,
} from "@/components/common/data-table"
import { RelativeTime } from "@/components/common/relative-time"
import { StatRail, StatRailItem, StatRailItemSkeleton } from "@/components/common/stat-rail"
import { deploymentStateLabel, deploymentTone } from "@/components/integrations/vercel-model"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"

import type { VercelFleetTotals, VercelProjectRow } from "./list-model"

const percentText = (percent: number | null) =>
	percent === null ? EMPTY_VALUE : formatPercent(percent / 100)
const errorText = (percent: number | null) =>
	percent === null ? EMPTY_VALUE : formatErrorRate(percent / 100)
const errorTone = (percent: number | null) => errorRateLevel(percent === null ? 0 : percent / 100)

/**
 * The fleet in five numbers. The spend cell opens the AI Gateway view, so the number and the
 * breakdown behind it are one click apart.
 */
export function VercelFleetBand({
	totals,
	projectCount,
	buckets,
	aiGateway,
	onOpenAiGateway,
}: {
	totals: VercelFleetTotals
	projectCount: number
	buckets: ReadonlyArray<VercelInfraRequestBucket>
	/** Null while AI Gateway usage loads. */
	aiGateway: { summary: VercelAiGatewaySummary; spark: ReadonlyArray<number> } | null
	onOpenAiGateway: () => void
}) {
	return (
		<StatRail columns={5}>
			<StatRailItem
				eyebrow="Requests"
				value={formatNumber(totals.requests)}
				spark={buckets.map((row) => row.requests)}
				subline={`across ${projectCount} ${projectCount === 1 ? "project" : "projects"}`}
			/>
			<StatRailItem
				eyebrow="5xx rate"
				value={errorText(totals.errorPercent)}
				tone={errorTone(totals.errorPercent)}
				spark={buckets.map((row) => row.requests5xx)}
				subline={`${formatNumber(totals.requests5xx)} server errors`}
			/>
			<StatRailItem
				eyebrow="Cache hits"
				value={percentText(totals.cacheHitPercent)}
				spark={buckets.map((row) => row.cacheHits)}
				subline={totals.cacheHitPercent === null ? "no cache lookups" : "of cache lookups"}
			/>
			<StatRailItem
				eyebrow="Error logs"
				value={formatNumber(totals.errorLogs)}
				tone={totals.errorLogs > 0 ? "warn" : "neutral"}
				spark={buckets.map((row) => row.errorLogs)}
				subline="error and fatal records"
			/>
			{aiGateway === null ? (
				<StatRailItemSkeleton />
			) : (
				<StatRailItem
					eyebrow="AI Gateway spend"
					value={
						aiGateway.summary.requests > 0 ? formatCost(aiGateway.summary.costUsd) : EMPTY_VALUE
					}
					spark={aiGateway.spark}
					subline={
						aiGateway.summary.requests > 0
							? `${formatNumber(aiGateway.summary.requests)} requests · by model`
							: "no requests · see setup"
					}
					onSelect={onOpenAiGateway}
					ariaLabel="Open AI Gateway usage"
				/>
			)}
		</StatRail>
	)
}

export function VercelFleetBandLoading() {
	return (
		<StatRail columns={5} aria-busy>
			{Array.from({ length: 5 }, (_, i) => (
				<StatRailItemSkeleton key={i} />
			))}
		</StatRail>
	)
}

/** State dot, state, branch and age of one deployment, on one line. */
export function DeploymentInline({ deployment }: { deployment: VercelDeploymentSummary }) {
	return (
		<span className="flex min-w-0 items-center gap-1.5 text-2xs">
			<StatusDot tone={deploymentTone(deployment.state)} size="lg" />
			<span className="shrink-0 text-foreground/80">{deploymentStateLabel(deployment.state)}</span>
			{deployment.branch ? (
				<span className="truncate font-mono text-muted-foreground" title={deployment.branch}>
					{deployment.branch}
				</span>
			) : null}
			<RelativeTime
				value={deployment.createdAt}
				variant="short"
				mono
				tooltip="title"
				className="shrink-0 text-muted-foreground"
			/>
		</span>
	)
}

type SortKey = "name" | "requests" | "sortError" | "sortCache" | "sortP95" | "errorLogs"

interface RowView extends VercelProjectRow {
	readonly sortError: number
	readonly sortCache: number
	readonly sortP95: number
}

// A missing rate or latency sorts below every real one.
const toView = (row: VercelProjectRow): RowView => ({
	...row,
	sortError: row.errorPercent ?? -1,
	sortCache: row.cacheHitPercent ?? -1,
	sortP95: row.p95DurationMs ?? -1,
})

function Columns({ sort }: { sort?: SortControls<SortKey> }) {
	return (
		<>
			<ColumnHead<SortKey> label="Project" sortKey="name" {...sort} width="w-0 flex-1 min-w-[200px]" />
			<ColumnHead label="Production" width="w-[220px]" hidden="hidden lg:flex" />
			<ColumnHead<SortKey>
				label="Requests"
				sortKey="requests"
				{...sort}
				align="right"
				width="w-[90px]"
			/>
			<ColumnHead<SortKey> label="5xx" sortKey="sortError" {...sort} align="right" width="w-[72px]" />
			<ColumnHead<SortKey>
				label="Cache hits"
				sortKey="sortCache"
				{...sort}
				align="right"
				width="w-[80px]"
				hidden="hidden md:flex"
			/>
			<ColumnHead<SortKey> label="p95" sortKey="sortP95" {...sort} align="right" width="w-[72px]" />
			<ColumnHead<SortKey>
				label="Error logs"
				sortKey="errorLogs"
				{...sort}
				align="right"
				width="w-[80px]"
			/>
		</>
	)
}

export function VercelProjectTableLoading() {
	return (
		<DataTable.Root ariaLabel="Vercel projects">
			<DataTable.Head>
				<Columns />
			</DataTable.Head>
			<DataTable.SkeletonRows count={5}>
				<div className="w-0 min-w-[200px] flex-1">
					<Skeleton className="h-4 w-36" />
				</div>
				<Skeleton className="hidden h-3 w-[220px] lg:block" />
				<Skeleton className="ml-auto h-3 w-[90px]" />
				<Skeleton className="h-3 w-[72px]" />
				<Skeleton className="hidden h-3 w-[80px] md:block" />
				<Skeleton className="h-3 w-[72px]" />
				<Skeleton className="h-3 w-[80px]" />
			</DataTable.SkeletonRows>
		</DataTable.Root>
	)
}

const NUM = "text-right font-mono text-xs tabular-nums"

export function VercelProjectTable({
	rows,
	timeSearch,
	waiting,
}: {
	rows: ReadonlyArray<VercelProjectRow>
	timeSearch: TimeRangeSearch
	waiting?: boolean
}) {
	const views = useMemo(() => rows.map(toView), [rows])
	const { sorted, sortKey, sortDir, handleSort } = useTableSort<RowView, SortKey>(views, {
		initialKey: "requests",
		stringKeys: ["name"],
	})
	return (
		<DataTable.Root ariaLabel="Vercel projects" waiting={waiting}>
			<DataTable.Head>
				<Columns sort={{ currentKey: sortKey, dir: sortDir, onSort: handleSort }} />
			</DataTable.Head>
			{sorted.map((row) => (
				<Link
					key={row.projectId}
					to="/infra/vercel/$projectId"
					params={{ projectId: row.projectId }}
					search={timeSearch}
					className={ROW_LINK_CLASS}
				>
					<div className="flex w-0 min-w-[200px] flex-1 items-baseline gap-2">
						<span
							className="truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary"
							title={row.name}
						>
							{row.name}
						</span>
						{row.framework ? (
							<span className="shrink-0 font-mono text-3xs text-muted-foreground">
								{row.framework}
							</span>
						) : null}
					</div>
					<div className="hidden w-[220px] lg:block">
						{row.production === null ? (
							<span className="text-2xs text-muted-foreground">no production deployment</span>
						) : (
							<DeploymentInline deployment={row.production} />
						)}
					</div>
					<div
						className={cn(
							NUM,
							"w-[90px]",
							row.requests === 0 ? "text-muted-foreground" : "text-foreground",
						)}
					>
						{formatNumber(row.requests)}
					</div>
					<div className={cn(NUM, "w-[72px]", ERROR_RATE_TEXT[errorTone(row.errorPercent)])}>
						{errorText(row.errorPercent)}
					</div>
					<div className={cn(NUM, "hidden w-[80px] text-foreground/80 md:block")}>
						{percentText(row.cacheHitPercent)}
					</div>
					<div
						className={cn(
							NUM,
							"w-[72px]",
							row.p95DurationMs === null ? "text-muted-foreground" : "text-foreground/80",
						)}
						title={
							row.p95DurationMs === null ? "This project sends no deployment traces" : undefined
						}
					>
						{row.p95DurationMs === null ? EMPTY_VALUE : formatLatency(row.p95DurationMs)}
					</div>
					<div
						className={cn(
							NUM,
							"w-[80px]",
							row.errorLogs > 0 ? TONE_TEXT.warn : "text-muted-foreground",
						)}
					>
						{formatNumber(row.errorLogs)}
					</div>
				</Link>
			))}
		</DataTable.Root>
	)
}
