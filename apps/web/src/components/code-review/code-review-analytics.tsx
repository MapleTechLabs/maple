import { useMemo, useState, type ReactNode } from "react"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { EMPTY_VALUE, countLabel, formatPercent } from "@maple/ui/lib/format"
import { Link } from "@tanstack/react-router"
import type { CodeReviewAnalytics, CodeReviewTotals, PrReviewSeverity } from "@maple/domain/http"
import { QueryBuilderBarChart } from "@maple/ui/components/charts"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Delta, relativeChange } from "@maple/ui/components/ui/delta"
import { Meter } from "@maple/ui/components/ui/meter"
import { Panel, PanelBody, PanelHeader } from "@maple/ui/components/ui/panel"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"

import { ArrowRightIcon, GithubIcon } from "@/components/icons"
import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import { pickTimeRangeSearch } from "@/components/time-range-picker/search"

import { AuthorLabel } from "./author-avatar"
import type { CodeReviewSearch } from "./code-review-search"
import { CATEGORY_LABELS, bucketIso, formatCount, formatSpan } from "./code-review-format"

type VolumeMetric = "pullRequests" | "reviews"
type SeverityFilter = "all" | PrReviewSeverity

const VOLUME_LABELS = { pullRequests: "PRs reviewed", reviews: "Reviews" } satisfies Record<
	VolumeMetric,
	string
>
const SEVERITY_FILTER_LABELS = {
	all: "All severities",
	critical: "Critical",
	warn: "Warning",
	info: "Note",
} satisfies Record<SeverityFilter, string>
/** Series names the shared palette colours by severity (see `SEVERITY_COLORS`). */
const SEVERITY_SERIES = { critical: "Critical", warn: "Warning", info: "Note" } satisfies Record<
	PrReviewSeverity,
	string
>

export function CodeReviewAnalyticsView({
	analytics,
	search,
	windowLabel,
}: {
	analytics: CodeReviewAnalytics
	search: CodeReviewSearch
	/** Names the comparison, e.g. "30d". */
	windowLabel: string
}) {
	return (
		<div className="flex flex-col gap-6">
			<HeadlineStrip
				current={analytics.current}
				previous={analytics.previous}
				windowLabel={windowLabel}
			/>
			<div className="grid gap-6 lg:grid-cols-2">
				<VolumeCard analytics={analytics} />
				<IssuesCard analytics={analytics} search={search} />
			</div>
			<div className="grid gap-6 lg:grid-cols-3">
				<CategoriesCard analytics={analytics} />
				<OutcomesCard current={analytics.current} analytics={analytics} />
				<AuthorsCard analytics={analytics} />
			</div>
			<SecondaryStats current={analytics.current} />
		</div>
	)
}

export function CodeReviewAnalyticsSkeleton() {
	return (
		<div className="flex flex-col gap-6">
			<Skeleton className="h-[118px] w-full rounded-xl" />
			<div className="grid gap-6 lg:grid-cols-2">
				<Skeleton className="h-[440px] w-full rounded-xl" />
				<Skeleton className="h-[440px] w-full rounded-xl" />
			</div>
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
	current: CodeReviewTotals
	previous: CodeReviewTotals
	windowLabel: string
}) {
	const versus = `vs previous ${windowLabel}`
	return (
		<StatRail>
			<StatRailItem
				compact
				eyebrow="Pull requests reviewed"
				value={formatCount(current.pullRequests)}
				delta={changeOf(current.pullRequests, previous.pullRequests)}
				subline={versus}
			/>
			<StatRailItem
				compact
				eyebrow="Total reviews"
				value={formatCount(current.reviews)}
				delta={changeOf(current.reviews, previous.reviews)}
				subline={versus}
			/>
			<div title="From a pull request's first review to its merge">
				<StatRailItem
					compact
					eyebrow="Avg time to merge"
					value={formatSpan(current.avgMergeSeconds)}
					delta={changeOf(current.avgMergeSeconds, previous.avgMergeSeconds, true)}
					subline={versus}
				/>
			</div>
			<StatRailItem
				compact
				eyebrow="Issues caught"
				value={formatCount(current.findings)}
				subline={
					current.repositoriesWithFindings > 0
						? `in ${countLabel(current.repositoriesWithFindings, "repo")}`
						: undefined
				}
			/>
		</StatRail>
	)
}

/* ---------------------------------------------------------------------------------------------- */

function AnalyticsPanel({
	title,
	control,
	children,
	footer,
}: {
	title: string
	control?: ReactNode
	children: ReactNode
	footer?: ReactNode
}) {
	return (
		<Panel>
			<PanelHeader title={title} action={control} />
			<PanelBody className="px-4 py-4">{children}</PanelBody>
			{footer ? <footer className="border-t px-4 py-4">{footer}</footer> : null}
		</Panel>
	)
}

function ChartFrame({ empty, children }: { empty: boolean; children: ReactNode }) {
	return empty ? (
		<EmptyMessage dashed className="flex h-56 items-center justify-center">
			Nothing in this window
		</EmptyMessage>
	) : (
		<div className="h-56 w-full">{children}</div>
	)
}

function VolumeCard({ analytics }: { analytics: CodeReviewAnalytics }) {
	const [metric, setMetric] = useState<VolumeMetric>("pullRequests")
	const label = VOLUME_LABELS[metric]
	const rows = useMemo(
		() => analytics.series.map((point) => ({ bucket: bucketIso(point.bucket), [label]: point[metric] })),
		[analytics.series, metric, label],
	)
	const repositories = [...analytics.repositories]
		.filter((repo) => repo.reviews > 0)
		.sort((a, b) => b.reviews - a.reviews)
		.slice(0, 5)

	return (
		<AnalyticsPanel
			title="Pull requests reviewed"
			control={
				<Select
					items={VOLUME_LABELS}
					value={metric}
					onValueChange={(value) => {
						if (value === "pullRequests" || value === "reviews") setMetric(value)
					}}
				>
					<SelectTrigger size="sm" className="w-36" aria-label="Volume metric">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="pullRequests">PRs reviewed</SelectItem>
						<SelectItem value="reviews">Reviews</SelectItem>
					</SelectContent>
				</Select>
			}
			footer={
				<RepositoryList
					title="Top repositories by reviews"
					rows={repositories.map((repo) => ({
						key: repo.repositoryId,
						name: repo.fullName,
						value: repo.reviews,
					}))}
				/>
			}
		>
			<ChartFrame empty={analytics.current.reviews === 0}>
				<QueryBuilderBarChart data={rows} legend="hidden" className="h-full w-full" />
			</ChartFrame>
		</AnalyticsPanel>
	)
}

function IssuesCard({ analytics, search }: { analytics: CodeReviewAnalytics; search: CodeReviewSearch }) {
	const [severity, setSeverity] = useState<SeverityFilter>("all")
	const rows = useMemo(
		() =>
			analytics.series.map((point) =>
				severity === "all"
					? {
							bucket: bucketIso(point.bucket),
							[SEVERITY_SERIES.critical]: point.critical,
							[SEVERITY_SERIES.warn]: point.warn,
							[SEVERITY_SERIES.info]: point.info,
						}
					: { bucket: bucketIso(point.bucket), [SEVERITY_SERIES[severity]]: point[severity] },
			),
		[analytics.series, severity],
	)
	const repositories = [...analytics.repositories]
		.filter((repo) => repo.findings > 0)
		.sort((a, b) => b.findings - a.findings)
		.slice(0, 5)

	return (
		<AnalyticsPanel
			title="Issues caught"
			control={
				<Select
					items={SEVERITY_FILTER_LABELS}
					value={severity}
					onValueChange={(value) => {
						if (value === "all" || value === "critical" || value === "warn" || value === "info")
							setSeverity(value)
					}}
				>
					<SelectTrigger size="sm" className="w-36" aria-label="Severity">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{(["all", "critical", "warn", "info"] as const).map((value) => (
							<SelectItem key={value} value={value}>
								{SEVERITY_FILTER_LABELS[value]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			footer={
				<div className="flex flex-col gap-3">
					<RepositoryList
						title="Repositories with the most issues"
						rows={repositories.map((repo) => ({
							key: repo.repositoryId,
							name: repo.fullName,
							value: repo.findings,
						}))}
					/>
					<Link
						to="/code-review/issues"
						search={{ ...pickTimeRangeSearch(search), repo: search.repo, author: search.author }}
						className="inline-flex items-center gap-1 self-center text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
					>
						See all issues caught
						<ArrowRightIcon size={13} aria-hidden />
					</Link>
				</div>
			}
		>
			<ChartFrame empty={analytics.current.findings === 0}>
				<QueryBuilderBarChart data={rows} stacked legend="hidden" className="h-full w-full" />
			</ChartFrame>
		</AnalyticsPanel>
	)
}

function RepositoryList({
	title,
	rows,
}: {
	title: string
	rows: ReadonlyArray<{ key: string; name: string; value: number }>
}) {
	return (
		<div className="flex flex-col gap-2">
			<span className="text-xs text-muted-foreground">{title}</span>
			{rows.length === 0 ? (
				<span className="py-1 text-sm text-muted-foreground/70">No repositories in this window</span>
			) : (
				<ul className="flex flex-col">
					{rows.map((row) => (
						<li key={row.key} className="flex items-center gap-2.5 py-1.5 text-sm">
							<GithubIcon size={15} className="shrink-0 text-muted-foreground" aria-hidden />
							<span className="min-w-0 flex-1 truncate">{row.name}</span>
							<span className="tabular-nums text-muted-foreground">
								{formatCount(row.value)}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

/* ---------------------------------------------------------------------------------------------- */

function BarList({
	rows,
	emptyLabel,
}: {
	rows: ReadonlyArray<{ key: string; label: string; value: number; tone?: string }>
	emptyLabel: string
}) {
	const max = Math.max(...rows.map((row) => row.value), 1)
	if (rows.length === 0) return <EmptyMessage>{emptyLabel}</EmptyMessage>
	return (
		<ul className="flex flex-col gap-2.5">
			{rows.map((row) => (
				<li key={row.key} className="flex flex-col gap-1">
					<span className="flex items-center justify-between gap-2 text-sm">
						<span className="truncate">{row.label}</span>
						<span className="tabular-nums text-muted-foreground">{formatCount(row.value)}</span>
					</span>
					<Meter
						value={row.value}
						max={max}
						className="h-1.5 bg-muted"
						fillClassName={row.tone ?? "bg-primary"}
					/>
				</li>
			))}
		</ul>
	)
}

function CategoriesCard({ analytics }: { analytics: CodeReviewAnalytics }) {
	return (
		<AnalyticsPanel title="Issues by category">
			<BarList
				emptyLabel="No issues in this window"
				rows={analytics.categories.map((row) => ({
					key: row.category,
					label: CATEGORY_LABELS[row.category],
					value: row.findings,
				}))}
			/>
		</AnalyticsPanel>
	)
}

function OutcomesCard({ current, analytics }: { current: CodeReviewTotals; analytics: CodeReviewAnalytics }) {
	return (
		<AnalyticsPanel title="Review outcomes">
			<BarList
				emptyLabel="No reviews in this window"
				rows={[
					{
						key: "issues",
						label: "Issues found",
						value: analytics.verdicts.issues,
						tone: TONE_FILL.warn,
					},
					{
						key: "clean",
						label: "Clean",
						value: analytics.verdicts.clean,
						tone: TONE_FILL.ok,
					},
					{
						key: "not_applicable",
						label: "Nothing to review",
						value: analytics.verdicts.notApplicable,
						tone: TONE_FILL.neutral,
					},
					{
						key: "failed",
						label: "Failed",
						value: current.failedReviews,
						tone: TONE_FILL.crit,
					},
					{
						key: "skipped",
						label: "Skipped",
						value: current.skippedReviews,
						tone: "bg-muted-foreground/30",
					},
				].filter((row) => row.value > 0)}
			/>
		</AnalyticsPanel>
	)
}

function AuthorsCard({ analytics }: { analytics: CodeReviewAnalytics }) {
	return (
		<AnalyticsPanel title="Top authors">
			{analytics.authors.length === 0 ? (
				<EmptyMessage>No authors in this window</EmptyMessage>
			) : (
				<Table size="sm" variant="bare">
					<TableHeader>
						<TableRow>
							<TableHead className="pl-0 font-normal">Author</TableHead>
							<TableHead className="text-right font-normal">PRs</TableHead>
							<TableHead className="pr-0 text-right font-normal">Issues</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{analytics.authors.map((row) => (
							<TableRow key={row.author}>
								<TableCell className="max-w-0 pl-0 text-sm">
									<AuthorLabel login={row.author} className="max-w-full" />
								</TableCell>
								<TableCell className="text-right text-sm tabular-nums">
									{formatCount(row.pullRequests)}
								</TableCell>
								<TableCell className="pr-0 text-right text-sm tabular-nums text-muted-foreground">
									{formatCount(row.findings)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</AnalyticsPanel>
	)
}

/* ---------------------------------------------------------------------------------------------- */

function SecondaryStats({ current }: { current: CodeReviewTotals }) {
	const settled = current.resolvedFindings + current.dismissedFindings
	const stats = [
		{
			label: "Avg confidence",
			value: current.avgConfidence === null ? EMPTY_VALUE : `${current.avgConfidence.toFixed(1)}/5`,
			hint: "How safe the reviewer judged each change to merge",
		},
		{
			label: "Avg quality",
			value: current.avgScore === null ? EMPTY_VALUE : `${Math.round(current.avgScore)}/100`,
			hint: "100 minus a fixed penalty per open finding",
		},
		{
			label: "Avg review time",
			value: formatSpan(current.avgReviewSeconds),
			hint: "From the push to the posted review",
		},
		{
			label: "Fixed rate",
			value:
				current.findings === 0
					? EMPTY_VALUE
					: formatPercent(current.resolvedFindings / current.findings),
			hint: "Issues a later push resolved",
		},
		{
			label: "Dismissed",
			value: settled === 0 ? EMPTY_VALUE : formatCount(current.dismissedFindings),
			hint: "Issues a person dismissed as not worth fixing",
		},
		{
			label: "Critical issues",
			value: formatCount(current.criticalFindings),
		},
		{
			label: "Tokens",
			value: formatCount(current.inputTokens + current.outputTokens),
			hint: `${formatCount(current.inputTokens)} in, ${formatCount(current.outputTokens)} out`,
		},
	]
	return (
		<StatRail className="xl:grid-cols-7">
			{stats.map((stat) => (
				<div key={stat.label} title={stat.hint}>
					<StatRailItem
						compact
						eyebrow={stat.label}
						value={stat.value}
						className="px-4 py-3"
						valueClassName="text-lg"
					/>
				</div>
			))}
		</StatRail>
	)
}
