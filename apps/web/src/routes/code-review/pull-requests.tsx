import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import type { CodeReviewListItem } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeFrom, toEpochMs } from "@maple/ui/lib/time-format"

import { formatCount, outcomeOf, SKIP_LABELS } from "@/components/code-review/code-review-format"
import {
	CodeReviewFilters,
	CodeReviewLayout,
	NothingInWindow,
} from "@/components/code-review/code-review-layout"
import {
	CODE_REVIEW_DEFAULT_PRESET,
	CodeReviewListSearchFields,
	type CodeReviewSearch,
} from "@/components/code-review/code-review-search"
import { AuthorLabel } from "@/components/code-review/author-avatar"
import { ReviewDetailSheet } from "@/components/code-review/review-detail-sheet"
import { QueryErrorState } from "@/components/common/query-error-state"
import { CircleCheckIcon, CircleWarningIcon, ClockIcon, LoaderIcon } from "@/components/icons"
import { useEffectiveTimeRange } from "@/hooks/use-effective-time-range"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"

const searchSchema = Schema.Struct(CodeReviewListSearchFields)
type Status = NonNullable<Schema.Schema.Type<typeof searchSchema>["status"]>

export const Route = createFileRoute("/code-review/pull-requests")({
	component: CodeReviewPullRequestsPage,
	validateSearch: Schema.toStandardSchemaV1(searchSchema),
})

const PAGE = 50
const MAX_ROWS = 200
/** How often the list refetches while a review is queued or running. */
const POLL_MS = 5_000

const STATUS_LABELS = {
	all: "All statuses",
	completed: "Completed",
	running: "Reviewing",
	queued: "Queued",
	failed: "Failed",
	skipped: "Skipped",
}
const isStatus = (value: unknown): value is Status =>
	value === "completed" ||
	value === "failed" ||
	value === "skipped" ||
	value === "running" ||
	value === "queued"

function CodeReviewPullRequestsPage() {
	const search = Route.useSearch()
	const navigate = useNavigate({ from: Route.fullPath })
	const preset = search.timePreset ?? CODE_REVIEW_DEFAULT_PRESET
	const { startTime, endTime } = useEffectiveTimeRange(search.startTime, search.endTime, preset)
	// The resolved window, shared by the page's query and the filters' author list.
	const window = { startTime: toEpochMs(startTime), endTime: toEpochMs(endTime) }
	const [limit, setLimit] = useState(PAGE)

	const query = retainedQuery("codeReview", "listReviews", {
		query: {
			...window,
			repositoryId: search.repo,
			author: search.author,
			status: search.status,
			limit,
		},
	})
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)
	const active = Result.builder(result)
		.onSuccess((response) =>
			response.reviews.some((review) => review.status === "queued" || review.status === "running"),
		)
		.orElse(() => false)
	useIntervalRefresh(refresh, { intervalMs: POLL_MS, enabled: active })

	const onChange = (
		patch: Partial<CodeReviewSearch> & { status?: Status; review?: typeof search.review },
	) => {
		// Opening or closing a review keeps the rows already loaded; a filter change starts over.
		if (Object.keys(patch).some((key) => key !== "review")) setLimit(PAGE)
		void navigate({ search: (prev) => ({ ...prev, ...patch }) })
	}
	const filtered = search.repo !== undefined || search.author !== undefined || search.status !== undefined

	return (
		<CodeReviewLayout
			active="pull-requests"
			search={search}
			toolbar={<CodeReviewFilters search={search} window={window} onChange={onChange} />}
		>
			<div className="flex items-center justify-between gap-3">
				<Select
					items={STATUS_LABELS}
					value={search.status ?? "all"}
					onValueChange={(value) => onChange({ status: isStatus(value) ? value : undefined })}
				>
					<SelectTrigger size="sm" className="w-40" aria-label="Status">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{Object.entries(STATUS_LABELS).map(([value, label]) => (
							<SelectItem key={value} value={value}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{Result.builder(result)
				.onInitial(() => (
					<div className="space-y-2">
						{Array.from({ length: 6 }, (_, i) => (
							<Skeleton key={i} className="h-14 w-full" />
						))}
					</div>
				))
				.onError((error) => (
					<QueryErrorState error={error} titleOverride="Failed to load reviews" onRetry={refresh} />
				))
				.onSuccess((response) =>
					response.reviews.length === 0 ? (
						<NothingInWindow
							title="No reviews in this window"
							description={
								filtered
									? "Nothing matches these filters."
									: "Reviews appear here once a pull request is opened on a reviewed repository."
							}
							onClear={
								filtered
									? () =>
											onChange({
												repo: undefined,
												author: undefined,
												status: undefined,
											})
									: undefined
							}
						/>
					) : (
						<div className="flex flex-col gap-3">
							<ReviewTable
								reviews={response.reviews}
								selected={search.review}
								onOpen={(review) => onChange({ review: review.id })}
							/>
							{response.nextCursor !== null ? (
								limit < MAX_ROWS ? (
									<Button
										variant="outline"
										size="sm"
										className="self-center"
										onClick={() =>
											setLimit((current) => Math.min(current + PAGE, MAX_ROWS))
										}
									>
										Load more
									</Button>
								) : (
									<p className="text-center text-xs text-muted-foreground">
										Showing the latest {MAX_ROWS}. Narrow the window to see older reviews.
									</p>
								)
							) : null}
						</div>
					),
				)
				.render()}
			<ReviewDetailSheet
				reviewId={search.review}
				onClose={() => onChange({ review: undefined })}
				onSelect={(review) => onChange({ review })}
			/>
		</CodeReviewLayout>
	)
}

const OUTCOME_ICONS = {
	queued: ClockIcon,
	running: LoaderIcon,
	failed: CircleWarningIcon,
	skipped: ClockIcon,
	issues: CircleWarningIcon,
	clean: CircleCheckIcon,
	neutral: CircleCheckIcon,
}

function ReviewTable({
	reviews,
	selected,
	onOpen,
}: {
	reviews: ReadonlyArray<CodeReviewListItem>
	selected: string | undefined
	onOpen: (review: CodeReviewListItem) => void
}) {
	return (
		<div className="overflow-hidden rounded-xl border bg-card">
			<table className="w-full table-fixed text-sm">
				<thead className="border-b bg-muted/30 text-xs text-muted-foreground">
					<tr>
						<th className="px-4 py-2.5 text-left font-normal">Pull request</th>
						<th className="hidden w-40 px-3 py-2.5 text-left font-normal md:table-cell">
							Outcome
						</th>
						<th className="hidden w-28 px-3 py-2.5 text-right font-normal lg:table-cell">
							Confidence
						</th>
						<th className="hidden w-24 px-3 py-2.5 text-right font-normal lg:table-cell">
							Quality
						</th>
						<th className="w-24 px-3 py-2.5 text-right font-normal">Issues</th>
						<th className="hidden w-28 px-4 py-2.5 text-right font-normal sm:table-cell">
							Reviewed
						</th>
					</tr>
				</thead>
				<tbody className="divide-y">
					{reviews.map((review) => {
						const outcome = outcomeOf(review)
						const Icon = OUTCOME_ICONS[outcome.kind]
						return (
							<tr
								key={review.id}
								onClick={() => onOpen(review)}
								className={cn(
									"cursor-pointer transition-colors hover:bg-muted/40",
									selected === review.id && "bg-muted/60",
								)}
							>
								<td className="px-4 py-3">
									<button
										type="button"
										onClick={(event) => {
											event.stopPropagation()
											onOpen(review)
										}}
										className="flex w-full min-w-0 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:underline"
									>
										<span className="shrink-0 text-muted-foreground">
											#{review.number}
										</span>
										<span className="truncate font-medium">
											{review.title ?? "Untitled pull request"}
										</span>
									</button>
									<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
										<span className="truncate">{review.repositoryFullName}</span>
										{review.authorLogin ? (
											<>
												<span className="shrink-0">·</span>
												<AuthorLabel
													login={review.authorLogin}
													className="shrink-0"
												/>
											</>
										) : null}
										<span className={cn("shrink-0 md:hidden", outcome.tone)}>
											· {outcome.label}
										</span>
									</div>
								</td>
								<td className="hidden px-3 py-3 md:table-cell">
									<span className={cn("inline-flex items-center gap-1.5", outcome.tone)}>
										<Icon
											size={14}
											className={
												outcome.kind === "running" ? "animate-spin" : undefined
											}
										/>
										{outcome.label}
									</span>
									{review.status === "skipped" && review.skipReason !== null ? (
										<div className="text-xs text-muted-foreground">
											{SKIP_LABELS[review.skipReason]}
										</div>
									) : null}
								</td>
								<td className="hidden px-3 py-3 text-right tabular-nums lg:table-cell">
									{review.confidence === null ? (
										<span className="text-muted-foreground">–</span>
									) : (
										<>
											{review.confidence}
											<span className="text-muted-foreground">/5</span>
										</>
									)}
								</td>
								<td className="hidden px-3 py-3 text-right tabular-nums lg:table-cell">
									{review.score === null ? (
										<span className="text-muted-foreground">–</span>
									) : (
										<>
											{review.score}
											<span className="text-muted-foreground">/100</span>
										</>
									)}
								</td>
								<td className="px-3 py-3 text-right tabular-nums">
									{review.status !== "completed" ? (
										<span className="text-muted-foreground">–</span>
									) : (
										<span className="inline-flex items-center gap-1.5">
											{review.criticalFindings > 0 ? (
												<span
													className="rounded bg-[var(--severity-error)]/12 px-1.5 text-xs text-[var(--severity-error)]"
													title="Critical"
												>
													{review.criticalFindings}
												</span>
											) : null}
											{formatCount(review.findings)}
										</span>
									)}
								</td>
								<td className="hidden whitespace-nowrap px-4 py-3 text-right text-muted-foreground sm:table-cell">
									{formatRelativeFrom(review.createdAt)}
								</td>
							</tr>
						)
					})}
				</tbody>
			</table>
		</div>
	)
}
