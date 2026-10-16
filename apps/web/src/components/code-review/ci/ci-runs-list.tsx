import { useState } from "react"
import { Link } from "@tanstack/react-router"
import type { CiRunResult, CodeReviewCiRun, VcsRepositoryId } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { ListFooter, LoadingMoreRow } from "@maple/ui/components/ui/list-footer"
import { Panel } from "@maple/ui/components/ui/panel"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import { formatDuration } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { RelativeTime } from "@/components/common/relative-time"
import { ResultView } from "@/components/common/result-view"
import { ExternalLinkIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

import { NothingInWindow } from "../code-review-layout"
import { externalUrl, pullRequestUrl } from "./ci-format"
import { CiResultBadge } from "./ci-result-badge"

const PAGE = 50
/** Failed jobs listed under a run before the rest fold into "+N more". */
const FAILED_JOBS_SHOWN = 3

export interface CiRunsFilter {
	readonly startTime: number
	readonly endTime: number
	readonly repositoryId: VcsRepositoryId | undefined
	readonly pipeline: string | undefined
	readonly branch: string | undefined
	readonly result: CiRunResult | undefined
}

/** The trace page, narrowed to the run's start so the lookup prunes partitions. */
export function TraceLink({ run, className }: { run: CodeReviewCiRun; className?: string }) {
	return (
		<Button
			variant="ghost"
			size="xs"
			className={className}
			render={
				<Link
					to="/traces/$traceId"
					params={{ traceId: run.traceId }}
					search={{ t: new Date(run.startedAt).toISOString() }}
				/>
			}
		>
			View trace
		</Button>
	)
}

/**
 * The runs, newest first, a page at a time by cursor. Each later page is its own query, so a
 * loaded page never refetches when the next one arrives. Mount with a `key` of the filter: a new
 * filter starts over from the first page.
 */
export function CiRunsList({
	filter,
	onBranch,
	onClear,
}: {
	filter: CiRunsFilter
	onBranch: (branch: string) => void
	/** Clears the run-only filters, offered when they emptied the list. */
	onClear?: () => void
}) {
	const [cursors, setCursors] = useState<ReadonlyArray<string>>([])
	const query = retainedInternalQuery("codeReview", "ciRuns", { query: { ...filter, limit: PAGE } })
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)
	const loadMore = (cursor: string) =>
		setCursors((current) => (current.includes(cursor) ? current : [...current, cursor]))
	const last = cursors[cursors.length - 1]

	return (
		<ResultView
			result={result}
			loading={<SkeletonList rows={6} rowClassName="h-14" gap="2" />}
			errorTitle="Failed to load CI runs"
			onRetry={refresh}
			isEmpty={(response) => response.runs.length === 0}
			empty={
				<NothingInWindow
					title="No runs match"
					description="No run in this window has this result or branch."
					onClear={onClear}
				/>
			}
		>
			{(response) => (
				<Panel>
					<Table size="sm" className="table-fixed">
						<TableHeader className="bg-muted/30">
							<TableRow>
								<TableHead className="w-24 px-3 font-normal sm:w-36 sm:px-4">
									Result
								</TableHead>
								<TableHead className="px-3 font-normal">Run</TableHead>
								<TableHead className="hidden px-3 text-right font-normal sm:table-cell sm:w-24">
									Duration
								</TableHead>
								<TableHead className="hidden px-3 text-right font-normal md:table-cell md:w-24">
									Started
								</TableHead>
								<TableHead className="hidden px-4 text-right font-normal sm:table-cell sm:w-48">
									<span className="sr-only">Links</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							<RunRows runs={response.runs} onBranch={onBranch} />
							{cursors.map((cursor) => (
								<RunsPage key={cursor} filter={filter} cursor={cursor} onBranch={onBranch} />
							))}
						</TableBody>
					</Table>
					{/* Below the table, not a colSpan row: on phones that would add phantom columns. */}
					{last === undefined ? (
						<MoreFooter next={response.nextCursor} onMore={loadMore} />
					) : (
						<PageFooter filter={filter} cursor={last} onMore={loadMore} />
					)}
				</Panel>
			)}
		</ResultView>
	)
}

const pageQuery = (filter: CiRunsFilter, cursor: string) =>
	retainedInternalQuery("codeReview", "ciRuns", { query: { ...filter, limit: PAGE, cursor } })

function RunsPage({
	filter,
	cursor,
	onBranch,
}: {
	filter: CiRunsFilter
	cursor: string
	onBranch: (branch: string) => void
}) {
	const result = useAtomValue(pageQuery(filter, cursor))
	return Result.builder(result)
		.onSuccess((response) => <RunRows runs={response.runs} onBranch={onBranch} />)
		.orElse(() => null)
}

/** The newest page's state: loading, failed with a retry, or a way to the next one. */
function PageFooter({
	filter,
	cursor,
	onMore,
}: {
	filter: CiRunsFilter
	cursor: string
	onMore: (cursor: string) => void
}) {
	const query = pageQuery(filter, cursor)
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)
	return Result.builder(result)
		.onSuccess((response) => <MoreFooter next={response.nextCursor} onMore={onMore} />)
		.onError(() => <ListFooter failed onLoadMore={refresh} />)
		.orElse(() => <LoadingMoreRow />)
}

function MoreFooter({ next, onMore }: { next: string | null; onMore: (cursor: string) => void }) {
	if (next === null) return null
	return <ListFooter hasMore onLoadMore={() => onMore(next)} />
}

function RunRows({
	runs,
	onBranch,
}: {
	runs: ReadonlyArray<CodeReviewCiRun>
	onBranch: (branch: string) => void
}) {
	return runs.map((run) => {
		const runUrl = externalUrl(run.url)
		const prUrl =
			run.pullRequest === null || runUrl === null ? null : pullRequestUrl(runUrl, run.pullRequest)
		const failed = run.failedJobs.slice(0, FAILED_JOBS_SHOWN)
		const hidden = run.failedJobs.length - failed.length
		return (
			<TableRow key={run.traceId}>
				<TableCell className="px-3 py-2.5 align-top leading-normal sm:px-4">
					<CiResultBadge result={run.result} attempt={run.attempt} className="flex-wrap" />
				</TableCell>
				<TableCell className="px-3 py-2.5 leading-normal">
					<div className="truncate font-medium" title={run.pipeline}>
						{run.pipeline}
					</div>
					<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
						<span className="max-w-full truncate" title={run.repository}>
							{run.repository}
						</span>
						{run.branch ? (
							<>
								<span aria-hidden>·</span>
								<button
									type="button"
									onClick={() => onBranch(run.branch)}
									title={`Show runs on ${run.branch}`}
									className="max-w-48 truncate font-mono hover:text-foreground hover:underline focus-visible:underline"
								>
									{run.branch}
								</button>
							</>
						) : null}
						{run.revision ? (
							<>
								<span aria-hidden>·</span>
								<TruncatedId value={run.revision} kind="sha" />
							</>
						) : null}
						{run.pullRequest !== null ? (
							<>
								<span aria-hidden>·</span>
								{prUrl === null ? (
									<span>#{run.pullRequest}</span>
								) : (
									<a
										href={prUrl}
										target="_blank"
										rel="noreferrer"
										className="hover:text-foreground hover:underline"
									>
										#{run.pullRequest}
									</a>
								)}
							</>
						) : null}
						{run.actor ? (
							<>
								<span aria-hidden>·</span>
								<span className="truncate">{run.actor}</span>
							</>
						) : null}
						<span className="sm:hidden">· {formatDuration(run.durationMs)}</span>
					</div>
					{failed.length > 0 ? (
						<ul className="mt-1 flex flex-col gap-0.5 text-xs">
							{failed.map((job) => {
								const jobUrl = externalUrl(job.url)
								return (
									<li key={job.job} className="flex min-w-0 gap-1.5">
										{jobUrl === null ? (
											<span className={cn("shrink-0 font-medium", TONE_TEXT.crit)}>
												{job.job}
											</span>
										) : (
											<a
												href={jobUrl}
												target="_blank"
												rel="noreferrer"
												className={cn(
													"shrink-0 font-medium hover:underline",
													TONE_TEXT.crit,
												)}
											>
												{job.job}
											</a>
										)}
										{job.reason ? (
											<span
												className="truncate text-muted-foreground"
												title={job.reason}
											>
												{job.reason}
											</span>
										) : null}
									</li>
								)
							})}
							{hidden > 0 ? (
								<li className="text-muted-foreground">+{hidden} more failed</li>
							) : null}
						</ul>
					) : null}
					<TraceLink run={run} className="mt-1 -ml-2 sm:hidden" />
				</TableCell>
				<TableCell className="hidden px-3 text-right align-top tabular-nums sm:table-cell">
					<span className="leading-normal">{formatDuration(run.durationMs)}</span>
				</TableCell>
				<TableCell className="hidden px-3 text-right align-top text-muted-foreground tabular-nums md:table-cell">
					<RelativeTime value={run.startedAt} variant="short" tooltip="title" />
				</TableCell>
				<TableCell className="hidden px-4 text-right align-top sm:table-cell">
					<span className="inline-flex items-center justify-end gap-1">
						<TraceLink run={run} />
						{runUrl === null ? null : (
							<Button
								variant="ghost"
								size="xs"
								render={
									<a
										href={runUrl}
										target="_blank"
										rel="noreferrer"
										aria-label="Open the run on GitHub"
									/>
								}
							>
								GitHub
								<ExternalLinkIcon aria-hidden />
							</Button>
						)}
					</span>
				</TableCell>
			</TableRow>
		)
	})
}
