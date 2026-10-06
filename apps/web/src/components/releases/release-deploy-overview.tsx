import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { countLabel, formatErrorRate, formatLatency, formatNumber, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { RelativeTime } from "@/components/common/relative-time"

import { ErrorState } from "@/components/common/error-state"
import { SectionCard } from "@/components/services/section-card"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { errorIssueFromV2 } from "@/lib/services/error-issues"
import { getReleasesResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { ReleaseChangeset } from "./release-changeset"
import { ReleaseHealthPill, releaseHealthFigure } from "./release-health"
import { IssueList } from "./release-issues-panel"
import {
	NEW_ISSUE_SLACK_MS,
	ROLLOUT_COMPLETE_SHARE,
	attributeIssues,
	deriveReleaseImpacts,
	groupReleases,
	previousSha,
	shortReleaseLabel,
	type ReleaseGroup,
	type ReleaseServiceImpact,
} from "./release-model"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { eyebrowVariants } from "@maple/ui/components/ui/eyebrow"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"

const ISSUE_LIMIT = 100
const NO_COUNTS: ReadonlyMap<string, number> = new Map()

interface ReleaseDeployOverviewProps {
	commitSha: string
	startTime: string
	endTime: string
	environments?: string[]
	timeSearch: TimeRangeSearch
}

/** One release across every service it reached: per-service impact, what shipped, what broke. */
export function ReleaseDeployOverview({
	commitSha,
	startTime,
	endTime,
	environments,
	timeSearch,
}: ReleaseDeployOverviewProps) {
	// Same input as the list page's unfiltered view, so arriving from it is a cache hit.
	const atom = getReleasesResultAtom({ data: { startTime, endTime, environments } })
	const result = useRefreshableAtomValue(atom)
	const refresh = useAtomRefresh(atom)
	const derived = useMemo(() => {
		if (!Result.isSuccess(result)) return undefined
		const impacts = deriveReleaseImpacts(result.value.releases, result.value.timeline)
		const group = groupReleases(impacts).find((candidate) => candidate.commitSha === commitSha)
		return { impacts, group }
	}, [result, commitSha])

	if (Result.isFailure(result)) {
		return <ErrorState error={result.cause} title="Failed to load release" onRetry={refresh} />
	}
	if (derived === undefined) {
		return (
			<div className="flex flex-col gap-3">
				<Skeleton className="h-4 w-80" />
				<Skeleton className="h-48 w-full rounded-md" />
				<Skeleton className="h-48 w-full rounded-md" />
			</div>
		)
	}
	const { impacts, group } = derived
	if (group === undefined) {
		return (
			<EmptyMessage className="rounded-md border bg-card text-sm">
				<span className="font-mono">{shortReleaseLabel(commitSha)}</span> served no traffic in this
				window. Widen the time range to include its deploy.
			</EmptyMessage>
		)
	}

	return (
		<div className="flex flex-col gap-3">
			<DeploySummary group={group} />
			<DeployServices group={group} environments={environments} timeSearch={timeSearch} />
			<ReleaseChangeset base={previousSha(group)} head={commitSha} />
			<DeployIssues group={group} impacts={impacts} />
		</div>
	)
}

function DeploySummary({ group }: { group: ReleaseGroup }) {
	const services = new Set(group.services.map((impact) => impact.serviceName)).size
	const flagged = group.services.filter((impact) => impact.health !== "healthy").length
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-xs text-muted-foreground">
			<span>
				first seen{" "}
				<RelativeTime
					value={group.firstSeen}
					variant="orDate"
					tooltip="title"
					className="text-foreground"
				/>
			</span>
			<span>
				<span className="font-medium tabular-nums text-foreground">{services}</span>{" "}
				{pluralize(services, "service")}
			</span>
			<span>
				<span className="font-medium tabular-nums text-foreground">
					{formatNumber(group.spanCount)}
				</span>{" "}
				requests
			</span>
			{flagged > 0 ? (
				<span className="text-severity-warn">{countLabel(flagged, "service")} flagged</span>
			) : null}
		</div>
	)
}

function BeforeAfter({
	before,
	after,
	format,
	tone,
}: {
	before: number | undefined
	after: number
	format: (value: number) => string
	tone?: "error" | "warn"
}) {
	return (
		<span className="inline-flex items-baseline gap-1 font-mono text-xs tabular-nums">
			{before !== undefined ? (
				<span className="text-[10px] text-muted-foreground/70">{format(before)} →</span>
			) : null}
			<span
				className={cn(
					tone === "error" && "text-severity-error",
					tone === "warn" && "text-severity-warn",
				)}
			>
				{format(after)}
			</span>
		</span>
	)
}

function DeployServices({
	group,
	environments,
	timeSearch,
}: {
	group: ReleaseGroup
	environments?: string[]
	timeSearch: TimeRangeSearch
}) {
	const rows = group.services.toSorted(
		(a, b) =>
			Number(a.health === "healthy") - Number(b.health === "healthy") || b.spanCount - a.spanCount,
	)
	return (
		<SectionCard
			title="Services"
			action={
				<span className="text-[11px] text-muted-foreground/70">
					against the version each replaced
				</span>
			}
		>
			<Table size="sm">
				<TableHeader>
					<TableRow className={cn(eyebrowVariants(), "hover:bg-transparent")}>
						<TableHead className="pl-4">Service</TableHead>
						<TableHead>Replaced</TableHead>
						<TableHead className="text-right">Requests</TableHead>
						<TableHead>Error rate</TableHead>
						<TableHead>p95</TableHead>
						<TableHead className="pr-4 text-right">Live share</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((impact) => (
						<DeployServiceRow
							key={`${impact.serviceName}:${impact.environment}`}
							impact={impact}
							environments={environments}
							timeSearch={timeSearch}
						/>
					))}
				</TableBody>
			</Table>
		</SectionCard>
	)
}

function DeployServiceRow({
	impact,
	environments,
	timeSearch,
}: {
	impact: ReleaseServiceImpact
	environments?: string[]
	timeSearch: TimeRangeSearch
}) {
	return (
		<TableRow className="border-border/60 hover:bg-muted/30">
			<TableCell className="pl-4">
				<Link
					to="/releases/$commitSha"
					params={{ commitSha: impact.commitSha }}
					search={{
						...timeSearch,
						service: impact.serviceName,
						environments: environments ?? (impact.environment ? [impact.environment] : undefined),
					}}
					className="inline-flex items-center gap-2 hover:underline"
				>
					<ServiceDot serviceName={impact.serviceName} />
					{impact.serviceName}
					{impact.environment && !environments?.length ? (
						<span className="text-muted-foreground/70">{impact.environment}</span>
					) : null}
					{impact.health === "healthy" ? null : (
						<ReleaseHealthPill health={impact.health} label={releaseHealthFigure(impact)} />
					)}
				</Link>
			</TableCell>
			<TableCell className="font-mono text-[11px] text-muted-foreground">
				{impact.baseline ? shortReleaseLabel(impact.baseline.commitSha) : "-"}
			</TableCell>
			<TableCell className="text-right font-mono tabular-nums">
				{formatNumber(impact.spanCount)}
			</TableCell>
			<TableCell>
				<BeforeAfter
					before={impact.baseline?.errorRate}
					after={impact.errorRate}
					format={formatErrorRate}
					tone={impact.health === "regressed" ? "error" : undefined}
				/>
			</TableCell>
			<TableCell>
				<BeforeAfter
					before={impact.baseline?.p95LatencyMs}
					after={impact.p95LatencyMs}
					format={formatLatency}
					tone={impact.health === "watch" ? "warn" : undefined}
				/>
			</TableCell>
			<TableCell
				className={cn(
					"pr-4 text-right font-mono tabular-nums",
					impact.share !== undefined && impact.share > 0 && impact.share < ROLLOUT_COMPLETE_SHARE
						? "text-primary"
						: "text-muted-foreground",
				)}
			>
				{impact.share === undefined ? "-" : `${Math.round(impact.share * 100)}%`}
			</TableCell>
		</TableRow>
	)
}

function DeployIssues({
	group,
	impacts,
}: {
	group: ReleaseGroup
	impacts: ReadonlyArray<ReleaseServiceImpact>
}) {
	const since = new Date(Date.parse(group.firstSeen) - NEW_ISSUE_SLACK_MS).toISOString()
	const result = useAtomValue(
		retainedQueryV2("errorIssues", "list", {
			query: { introduced_after: since, limit: ISSUE_LIMIT },
			reactivityKeys: ["errorIssues"],
		}),
	)
	const issues = useMemo(() => {
		if (!Result.isSuccess(result)) return undefined
		const documents: ErrorIssueDocument[] = result.value.data.map(errorIssueFromV2)
		return attributeIssues(impacts, documents).get(group.commitSha) ?? { fresh: [], regressed: [] }
	}, [result, impacts, group.commitSha])

	if (issues === undefined) {
		return Result.isFailure(result) ? (
			<ErrorState error={result.cause} title="Issues could not be loaded" variant="row" />
		) : (
			<Skeleton className="h-32 w-full rounded-md" />
		)
	}
	const multi = group.services.length > 1
	return (
		<div className="grid gap-3 lg:grid-cols-2">
			<IssueList
				title="New with this release"
				issues={issues.fresh}
				counts={NO_COUNTS}
				empty="No issue first appeared while this release was live."
				tone="error"
				showService={multi}
			/>
			<IssueList
				title="Regressed with this release"
				issues={issues.regressed}
				counts={NO_COUNTS}
				empty="Nothing fixed before came back while this release was live."
				tone="warn"
				showService={multi}
			/>
		</div>
	)
}
