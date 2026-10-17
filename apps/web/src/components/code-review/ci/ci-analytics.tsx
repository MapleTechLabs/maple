import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import type {
	CodeReviewCiAnalytics,
	CodeReviewCiJob,
	CodeReviewCiPipeline,
	CodeReviewCiTotals,
} from "@maple/domain/http"
import { QueryBuilderBarChart, QueryBuilderLineChart } from "@maple/ui/components/charts"
import { Badge } from "@maple/ui/components/ui/badge"
import { Delta, relativeChange } from "@maple/ui/components/ui/delta"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { ROW_LANE } from "@maple/ui/components/ui/list-row"
import { Panel, PanelHeader } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import { EMPTY_VALUE, formatDuration, formatPercent } from "@maple/ui/lib/format"
import { TONE_SOFT, TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { RelativeTime } from "@/components/common/relative-time"
import { StatRail, StatRailItem } from "@/components/common/stat-rail"

import { AnalyticsPanel, ChartFrame } from "../code-review-analytics"
import { bucketIso, formatCount, formatSpan } from "../code-review-format"
import { failRate, rateChange, successRate } from "./ci-format"
import { CiResultBadge } from "./ci-result-badge"

/** Series names the shared palette colours as run results (see `semantic-series-colors`). */
const RESULT_SERIES = { succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled" } as const

const durationOf = (ms: number | null) => (ms === null ? EMPTY_VALUE : formatDuration(ms))
const ciTimeOf = (ms: number) => formatSpan(ms / 1000)
const rateOf = (rate: number | null) => (rate === null ? EMPTY_VALUE : formatPercent(rate))
const points = (magnitude: number) => `${(magnitude * 100).toFixed(1)}pp`

export function CiAnalyticsView({
	analytics,
	windowLabel,
	pipeline,
	onSelectPipeline,
}: {
	analytics: CodeReviewCiAnalytics
	/** Names the comparison, e.g. "7d". */
	windowLabel: string
	pipeline: string | undefined
	onSelectPipeline: (pipeline: string | undefined) => void
}) {
	return (
		<div className="flex flex-col gap-6">
			<HeadlineStrip
				current={analytics.current}
				previous={analytics.previous}
				windowLabel={windowLabel}
			/>
			<div className="grid gap-6 lg:grid-cols-2">
				<RunsCard analytics={analytics} />
				<DurationCard analytics={analytics} />
			</div>
			<WorkflowsTable
				pipelines={analytics.pipelines}
				selected={pipeline}
				onSelect={(name) => onSelectPipeline(name === pipeline ? undefined : name)}
			/>
			<JobsTable jobs={analytics.jobs} />
		</div>
	)
}

export function CiAnalyticsSkeleton() {
	return (
		<div className="flex flex-col gap-6">
			<Skeleton className="h-[118px] w-full rounded-md" />
			<div className="grid gap-6 lg:grid-cols-2">
				<Skeleton className="h-[300px] w-full rounded-md" />
				<Skeleton className="h-[300px] w-full rounded-md" />
			</div>
			<Skeleton className="h-64 w-full rounded-md" />
		</div>
	)
}

/* ---------------------------------------------------------------------------------------------- */

/** Change against the previous window; nothing when there is no baseline to compare with. */
function changeOf(current: number | null, previous: number | null, invert = false) {
	const ratio = current === null || previous === null ? null : relativeChange(current, previous)
	return ratio === null ? undefined : <Delta ratio={ratio} invert={invert} />
}

function HeadlineStrip({
	current,
	previous,
	windowLabel,
}: {
	current: CodeReviewCiTotals
	previous: CodeReviewCiTotals
	windowLabel: string
}) {
	const versus = `vs previous ${windowLabel}`
	const rate = successRate(current)
	const rateDelta = rateChange(rate, successRate(previous))
	const runsRatio = relativeChange(current.runs, previous.runs)
	const stats = [
		{
			label: "Runs",
			value: formatCount(current.runs),
			delta: runsRatio === null ? undefined : <Delta ratio={runsRatio} muteWorse />,
		},
		{
			label: "Success rate",
			value: rateOf(rate),
			delta: rateDelta === null ? undefined : <Delta ratio={rateDelta} format={points} />,
			hint: "Passed runs over passed and failed ones; cancelled runs are left out",
		},
		{
			label: "p50 run time",
			value: durationOf(current.p50DurationMs),
			delta: changeOf(current.p50DurationMs, previous.p50DurationMs, true),
		},
		{
			label: "p95 run time",
			value: durationOf(current.p95DurationMs),
			delta: changeOf(current.p95DurationMs, previous.p95DurationMs, true),
		},
		{
			label: "Runner wait",
			value: durationOf(current.p50QueueMs),
			delta: changeOf(current.p50QueueMs, previous.p50QueueMs, true),
			hint: "Median time a job waited for a runner to pick it up",
		},
		{
			label: "CI time",
			value: ciTimeOf(current.totalDurationMs),
			delta: changeOf(current.totalDurationMs, previous.totalDurationMs, true),
			hint: "Wall-clock time of every run added up",
		},
	]
	return (
		<StatRail columns={3} className="xl:grid-cols-6">
			{stats.map((stat) => (
				<div key={stat.label} title={stat.hint}>
					<StatRailItem
						compact
						eyebrow={stat.label}
						value={stat.value}
						delta={stat.delta}
						subline={versus}
					/>
				</div>
			))}
		</StatRail>
	)
}

/* ---------------------------------------------------------------------------------------------- */

/** `owner/name`, as GitHub writes it; a repository without an owner is just its name. */
const repositoryLabel = (row: { readonly owner: string; readonly repository: string }) =>
	row.owner === "" ? row.repository : `${row.owner}/${row.repository}`

function RunsCard({ analytics }: { analytics: CodeReviewCiAnalytics }) {
	const rows = useMemo(
		() =>
			analytics.series.map((point) => ({
				bucket: bucketIso(point.bucket),
				[RESULT_SERIES.succeeded]: point.succeeded,
				[RESULT_SERIES.failed]: point.failed,
				[RESULT_SERIES.cancelled]: point.cancelled,
			})),
		[analytics.series],
	)
	return (
		<AnalyticsPanel title="Runs by result">
			<ChartFrame empty={analytics.current.runs === 0}>
				<QueryBuilderBarChart data={rows} stacked legend="hidden" className="h-full w-full" />
			</ChartFrame>
		</AnalyticsPanel>
	)
}

function DurationCard({ analytics }: { analytics: CodeReviewCiAnalytics }) {
	const rows = useMemo(
		() =>
			analytics.series.map((point) => ({
				bucket: bucketIso(point.bucket),
				p50: point.p50DurationMs,
				p95: point.p95DurationMs,
			})),
		[analytics.series],
	)
	return (
		<AnalyticsPanel title="Run time">
			<ChartFrame empty={analytics.current.runs === 0}>
				<QueryBuilderLineChart
					data={rows}
					unit="duration_ms"
					legend="hidden"
					className="h-full w-full"
				/>
			</ChartFrame>
		</AnalyticsPanel>
	)
}

/* ---------------------------------------------------------------------------------------------- */

function WorkflowsTable({
	pipelines,
	selected,
	onSelect,
}: {
	pipelines: ReadonlyArray<CodeReviewCiPipeline>
	selected: string | undefined
	onSelect: (pipeline: string) => void
}) {
	return (
		<Panel>
			<PanelHeader title="Workflows" />
			{pipelines.length === 0 ? (
				<EmptyMessage className="px-4 py-6">No workflows ran in this window</EmptyMessage>
			) : (
				<Table size="sm" className="table-fixed">
					<TableHeader className="bg-muted/30">
						<TableRow>
							<TableHead className="px-4 font-normal">Workflow</TableHead>
							<TableHead className="w-20 px-3 text-right font-normal">Runs</TableHead>
							<TableHead className="w-24 px-3 text-right font-normal">Fail rate</TableHead>
							<TableHead className="hidden px-3 text-right font-normal lg:table-cell lg:w-24">
								p50
							</TableHead>
							<TableHead className="hidden px-3 text-right font-normal lg:table-cell lg:w-24">
								p95
							</TableHead>
							<TableHead className="hidden px-3 text-right font-normal md:table-cell md:w-24">
								CI time
							</TableHead>
							<TableHead className="hidden px-4 font-normal sm:table-cell sm:w-44">
								Last run
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{pipelines.map((row) => {
							const active = selected === row.pipeline
							const rate = failRate(row.failed, row.runs)
							return (
								<TableRow
									key={`${row.owner}/${row.repository}/${row.pipeline}`}
									onClick={() => onSelect(row.pipeline)}
									className={cn(
										"cursor-pointer transition-colors hover:bg-muted/40",
										active && "bg-muted/40",
									)}
								>
									<TableCell
										className={cn(
											"px-4 py-2.5 leading-normal",
											ROW_LANE,
											active ? "before:bg-primary" : "before:bg-transparent",
										)}
									>
										<button
											type="button"
											aria-pressed={active}
											onClick={(event) => {
												event.stopPropagation()
												onSelect(row.pipeline)
											}}
											className="flex w-full min-w-0 items-center gap-2 text-left focus-visible:underline focus-visible:outline-none"
										>
											<span className="truncate font-medium" title={row.pipeline}>
												{row.pipeline}
											</span>
											{row.red ? (
												<Badge size="sm" className={cn("shrink-0", TONE_SOFT.crit)}>
													Failing · {formatCount(row.red.failedRuns)}{" "}
													{row.red.failedRuns === 1 ? "run" : "runs"}
												</Badge>
											) : null}
										</button>
										<div
											className="mt-0.5 truncate text-xs text-muted-foreground"
											title={repositoryLabel(row)}
										>
											{repositoryLabel(row)}
										</div>
										{row.red ? <RedStreakLine red={row.red} /> : null}
									</TableCell>
									<TableCell className="px-3 text-right tabular-nums">
										{formatCount(row.runs)}
									</TableCell>
									<TableCell
										className={cn(
											"px-3 text-right tabular-nums",
											rate !== null && rate > 0
												? TONE_TEXT.crit
												: "text-muted-foreground",
										)}
									>
										{rateOf(rate)}
									</TableCell>
									<TableCell className="hidden px-3 text-right tabular-nums lg:table-cell">
										{formatDuration(row.p50DurationMs)}
									</TableCell>
									<TableCell className="hidden px-3 text-right tabular-nums lg:table-cell">
										{formatDuration(row.p95DurationMs)}
									</TableCell>
									<TableCell className="hidden px-3 text-right tabular-nums md:table-cell">
										{ciTimeOf(row.totalDurationMs)}
									</TableCell>
									<TableCell className="hidden px-4 sm:table-cell">
										<span className="flex items-center gap-2">
											<CiResultBadge result={row.lastResult} />
											<RelativeTime
												value={row.lastStartedAt}
												variant="short"
												tooltip="title"
												className="text-xs text-muted-foreground"
											/>
										</span>
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			)}
		</Panel>
	)
}

/** Where the streak began and the commit that last passed. */
function RedStreakLine({ red }: { red: NonNullable<CodeReviewCiPipeline["red"]> }) {
	return (
		<div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
			<span>First failed at</span>
			<Link
				to="/traces/$traceId"
				params={{ traceId: red.firstFailedTraceId }}
				search={{ t: new Date(red.since).toISOString() }}
				onClick={(event) => event.stopPropagation()}
				className="text-foreground underline-offset-4 hover:underline"
				title="Open the first failed run's trace"
			>
				<TruncatedId value={red.firstFailedRevision} kind="sha" />
			</Link>
			<RelativeTime value={red.since} variant="short" tooltip="title" />
			<span aria-hidden>·</span>
			{red.lastGreenRevision === null ? (
				<span>no green run in this window</span>
			) : (
				<span>
					last green{" "}
					<TruncatedId value={red.lastGreenRevision} kind="sha" className="text-foreground" />
				</span>
			)}
		</div>
	)
}

/* ---------------------------------------------------------------------------------------------- */

function JobsTable({ jobs }: { jobs: ReadonlyArray<CodeReviewCiJob> }) {
	return (
		<Panel>
			<PanelHeader title="Jobs by CI time" />
			{jobs.length === 0 ? (
				<EmptyMessage className="px-4 py-6">No jobs ran in this window</EmptyMessage>
			) : (
				<Table size="sm" className="table-fixed">
					<TableHeader className="bg-muted/30">
						<TableRow>
							<TableHead className="px-4 font-normal">Job</TableHead>
							<TableHead className="w-20 px-3 text-right font-normal">Runs</TableHead>
							<TableHead className="w-24 px-3 text-right font-normal">Fail rate</TableHead>
							<TableHead className="hidden px-3 text-right font-normal md:table-cell md:w-20">
								Retried
							</TableHead>
							<TableHead className="hidden px-3 text-right font-normal lg:table-cell lg:w-24">
								p50
							</TableHead>
							<TableHead className="hidden px-3 text-right font-normal lg:table-cell lg:w-24">
								p95
							</TableHead>
							<TableHead
								className="hidden px-3 text-right font-normal xl:table-cell xl:w-24"
								title="How long the job waited for a runner"
							>
								Wait p50
							</TableHead>
							<TableHead
								className="hidden px-4 text-right font-normal xl:table-cell xl:w-24"
								title="How long the job waited for a runner"
							>
								Wait p95
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{jobs.map((row) => {
							const rate = failRate(row.failed, row.runs)
							return (
								<TableRow key={`${row.owner}/${row.repository}/${row.pipeline}/${row.job}`}>
									<TableCell className="px-4 py-2.5 leading-normal">
										<div className="truncate font-medium" title={row.job}>
											{row.job}
										</div>
										<div
											className="mt-0.5 truncate text-xs text-muted-foreground"
											title={`${repositoryLabel(row)} · ${row.pipeline}`}
										>
											{row.pipeline} · {repositoryLabel(row)}
										</div>
									</TableCell>
									<TableCell className="px-3 text-right tabular-nums">
										{formatCount(row.runs)}
									</TableCell>
									<TableCell
										className={cn(
											"px-3 text-right tabular-nums",
											rate !== null && rate > 0
												? TONE_TEXT.crit
												: "text-muted-foreground",
										)}
									>
										{rateOf(rate)}
									</TableCell>
									<TableCell className="hidden px-3 text-right tabular-nums text-muted-foreground md:table-cell">
										{formatCount(row.retried)}
									</TableCell>
									<TableCell className="hidden px-3 text-right tabular-nums lg:table-cell">
										{formatDuration(row.p50DurationMs)}
									</TableCell>
									<TableCell className="hidden px-3 text-right tabular-nums lg:table-cell">
										{formatDuration(row.p95DurationMs)}
									</TableCell>
									<TableCell className="hidden px-3 text-right tabular-nums text-muted-foreground xl:table-cell">
										{formatDuration(row.p50QueueMs)}
									</TableCell>
									<TableCell className="hidden px-4 text-right tabular-nums text-muted-foreground xl:table-cell">
										{formatDuration(row.p95QueueMs)}
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			)}
		</Panel>
	)
}
