import { useMemo, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { CodeReviewAnalytics, CodeReviewTotals, PrReviewSeverity } from "@maple/domain/http"
import { QueryBuilderBarChart } from "@maple/ui/components/charts"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"

import { ArrowRightIcon, ArrowTrendDownIcon, ArrowTrendUpIcon, GithubIcon } from "@/components/icons"
import { pickTimeRangeSearch } from "@/components/time-range-picker/search"

import { AuthorLabel } from "./author-avatar"
import type { CodeReviewSearch } from "./code-review-search"
import {
	CATEGORY_LABELS,
	bucketIso,
	deltaOf,
	formatCount,
	formatDelta,
	formatSpan,
	type Delta,
} from "./code-review-format"

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

function HeadlineStrip({
	current,
	previous,
	windowLabel,
}: {
	current: CodeReviewTotals
	previous: CodeReviewTotals
	windowLabel: string
}) {
	return (
		<div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-4">
			<Headline
				label="Pull requests reviewed"
				value={formatCount(current.pullRequests)}
				delta={deltaOf(current.pullRequests, previous.pullRequests, true)}
				windowLabel={windowLabel}
			/>
			<Headline
				label="Total reviews"
				value={formatCount(current.reviews)}
				delta={deltaOf(current.reviews, previous.reviews, true)}
				windowLabel={windowLabel}
			/>
			<Headline
				label="Avg time to merge"
				value={formatSpan(current.avgMergeSeconds)}
				delta={deltaOf(current.avgMergeSeconds, previous.avgMergeSeconds, false)}
				windowLabel={windowLabel}
				hint="From a pull request's first review to its merge"
			/>
			<Headline
				label="Issues caught"
				value={formatCount(current.findings)}
				suffix={
					current.repositoriesWithFindings > 0
						? `in ${current.repositoriesWithFindings} ${current.repositoriesWithFindings === 1 ? "repo" : "repos"}`
						: undefined
				}
				windowLabel={windowLabel}
			/>
		</div>
	)
}

function Headline({
	label,
	value,
	suffix,
	delta,
	windowLabel,
	hint,
}: {
	label: string
	value: string
	suffix?: string
	delta?: Delta | null
	windowLabel: string
	hint?: string
}) {
	return (
		<div className="flex min-w-0 flex-col gap-2 bg-card px-5 py-4" title={hint}>
			<span className="text-sm text-muted-foreground">{label}</span>
			<span className="flex items-baseline gap-2.5">
				<span className="text-3xl font-semibold tracking-[-0.02em] tabular-nums">{value}</span>
				{suffix ? <span className="text-base text-muted-foreground">{suffix}</span> : null}
				{delta ? <DeltaBadge delta={delta} /> : null}
			</span>
			<span className="h-4 text-xs text-muted-foreground/70">
				{delta ? `vs previous ${windowLabel}` : null}
			</span>
		</div>
	)
}

/** Colour follows improvement, the arrow follows the number, so colour never carries it alone. */
function DeltaBadge({ delta }: { delta: Delta }) {
	const Icon = delta.change >= 0 ? ArrowTrendUpIcon : ArrowTrendDownIcon
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums",
				delta.change === 0
					? "bg-muted text-muted-foreground"
					: delta.good
						? "bg-[var(--severity-info)]/12 text-[var(--severity-info)]"
						: "bg-[var(--severity-error)]/12 text-[var(--severity-error)]",
			)}
		>
			<Icon size={12} aria-hidden />
			{formatDelta(delta)}
		</span>
	)
}

/* ---------------------------------------------------------------------------------------------- */

function Card({
	title,
	control,
	children,
	footer,
	className,
}: {
	title: string
	control?: ReactNode
	children: ReactNode
	footer?: ReactNode
	className?: string
}) {
	return (
		<section className={cn("flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card", className)}>
			<header className="flex h-14 items-center justify-between gap-3 border-b px-5">
				<h2 className="text-sm font-medium">{title}</h2>
				{control}
			</header>
			<div className="flex-1 px-5 py-4">{children}</div>
			{footer ? <footer className="border-t px-5 py-4">{footer}</footer> : null}
		</section>
	)
}

function ChartFrame({ empty, children }: { empty: boolean; children: ReactNode }) {
	return empty ? (
		<div className="flex h-56 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
			Nothing in this window
		</div>
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
		<Card
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
		</Card>
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
		<Card
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
		</Card>
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
	if (rows.length === 0)
		return <p className="py-6 text-center text-sm text-muted-foreground">{emptyLabel}</p>
	return (
		<ul className="flex flex-col gap-2.5">
			{rows.map((row) => (
				<li key={row.key} className="flex flex-col gap-1">
					<span className="flex items-center justify-between gap-2 text-sm">
						<span className="truncate">{row.label}</span>
						<span className="tabular-nums text-muted-foreground">{formatCount(row.value)}</span>
					</span>
					<span className="h-1.5 overflow-hidden rounded-full bg-muted">
						<span
							className={cn("block h-full rounded-full", row.tone ?? "bg-primary")}
							style={{ width: `${(row.value / max) * 100}%` }}
						/>
					</span>
				</li>
			))}
		</ul>
	)
}

function CategoriesCard({ analytics }: { analytics: CodeReviewAnalytics }) {
	return (
		<Card title="Issues by category">
			<BarList
				emptyLabel="No issues in this window"
				rows={analytics.categories.map((row) => ({
					key: row.category,
					label: CATEGORY_LABELS[row.category],
					value: row.findings,
				}))}
			/>
		</Card>
	)
}

function OutcomesCard({ current, analytics }: { current: CodeReviewTotals; analytics: CodeReviewAnalytics }) {
	return (
		<Card title="Review outcomes">
			<BarList
				emptyLabel="No reviews in this window"
				rows={[
					{
						key: "issues",
						label: "Issues found",
						value: analytics.verdicts.issues,
						tone: "bg-[var(--severity-warn)]",
					},
					{
						key: "clean",
						label: "Clean",
						value: analytics.verdicts.clean,
						tone: "bg-[var(--severity-info)]",
					},
					{
						key: "not_applicable",
						label: "Nothing to review",
						value: analytics.verdicts.notApplicable,
						tone: "bg-muted-foreground/50",
					},
					{
						key: "failed",
						label: "Failed",
						value: current.failedReviews,
						tone: "bg-[var(--severity-error)]",
					},
					{
						key: "skipped",
						label: "Skipped",
						value: current.skippedReviews,
						tone: "bg-muted-foreground/30",
					},
				].filter((row) => row.value > 0)}
			/>
		</Card>
	)
}

function AuthorsCard({ analytics }: { analytics: CodeReviewAnalytics }) {
	return (
		<Card title="Top authors">
			{analytics.authors.length === 0 ? (
				<p className="py-6 text-center text-sm text-muted-foreground">No authors in this window</p>
			) : (
				<table className="w-full text-sm">
					<thead>
						<tr className="text-xs text-muted-foreground">
							<th className="pb-2 text-left font-normal">Author</th>
							<th className="pb-2 text-right font-normal">PRs</th>
							<th className="pb-2 text-right font-normal">Issues</th>
						</tr>
					</thead>
					<tbody>
						{analytics.authors.map((row) => (
							<tr key={row.author}>
								<td className="max-w-0 py-1.5 pr-3">
									<AuthorLabel login={row.author} className="max-w-full" />
								</td>
								<td className="py-1.5 text-right tabular-nums">
									{formatCount(row.pullRequests)}
								</td>
								<td className="py-1.5 text-right tabular-nums text-muted-foreground">
									{formatCount(row.findings)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</Card>
	)
}

/* ---------------------------------------------------------------------------------------------- */

function SecondaryStats({ current }: { current: CodeReviewTotals }) {
	const settled = current.resolvedFindings + current.dismissedFindings
	const stats = [
		{
			label: "Avg confidence",
			value: current.avgConfidence === null ? "–" : `${current.avgConfidence.toFixed(1)}/5`,
			hint: "How safe the reviewer judged each change to merge",
		},
		{
			label: "Avg quality",
			value: current.avgScore === null ? "–" : `${Math.round(current.avgScore)}/100`,
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
					? "–"
					: `${Math.round((current.resolvedFindings / current.findings) * 100)}%`,
			hint: "Issues a later push resolved",
		},
		{
			label: "Dismissed",
			value: settled === 0 ? "–" : formatCount(current.dismissedFindings),
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
		<dl className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4 xl:grid-cols-7">
			{stats.map((stat) => (
				<div key={stat.label} className="flex flex-col gap-1 bg-card px-4 py-3" title={stat.hint}>
					<dt className="text-xs text-muted-foreground">{stat.label}</dt>
					<dd className="text-lg font-medium tabular-nums">{stat.value}</dd>
				</div>
			))}
		</dl>
	)
}
