import {
	PR_REVIEW_MODELS,
	type CodeReviewDetail,
	type CodeReviewFinding,
	type PrReviewFinding,
	type PrReviewId,
	type PrReviewPostMerge,
	type PrReviewTelemetry,
} from "@maple/domain/http"
import { DateTime } from "effect"
import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetPanel, SheetTitle } from "@maple/ui/components/ui/sheet"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { EMPTY_VALUE, countLabel } from "@maple/ui/lib/format"

import { MessageResponse } from "@/components/ai-elements/message-response"
import { ErrorState } from "@/components/common/error-state"
import { RelativeTime } from "@/components/common/relative-time"
import { SectionHeading } from "@/components/common/section-heading"
import { SheetDetailHeader } from "@/components/common/sheet-detail-header"
import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import { ExternalLinkIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomValue } from "@/lib/effect-atom"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

import { AuthorLabel } from "./author-avatar"
import {
	CATEGORY_LABELS,
	FINDING_STATUS_LABELS,
	SEVERITY_LABELS,
	SEVERITY_TONE,
	SKIP_LABELS,
	formatCount,
	formatSpan,
	outcomeOf,
} from "./code-review-format"

/** One review, opened from the list: the report as the reviewer filed it, and its findings' fate. */
export function ReviewDetailSheet({
	reviewId,
	onClose,
	onSelect,
}: {
	reviewId: PrReviewId | undefined
	onClose: () => void
	onSelect: (reviewId: PrReviewId) => void
}) {
	return (
		<Sheet open={reviewId !== undefined} onOpenChange={(open) => (open ? undefined : onClose())}>
			<SheetContent className="w-full sm:max-w-2xl">
				{reviewId === undefined ? null : <ReviewDetailBody reviewId={reviewId} onSelect={onSelect} />}
			</SheetContent>
		</Sheet>
	)
}

function ReviewDetailBody({
	reviewId,
	onSelect,
}: {
	reviewId: PrReviewId
	onSelect: (reviewId: PrReviewId) => void
}) {
	const query = retainedInternalQuery("codeReview", "getReview", { params: { reviewId } })
	const result = useAtomValue(query)
	const refresh = useAtomRefresh(query)

	return Result.builder(result)
		.onInitial(() => (
			<>
				<SheetHeader>
					<SheetTitle>
						<Skeleton className="h-6 w-72" />
					</SheetTitle>
				</SheetHeader>
				<SheetPanel className="space-y-4">
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-40 w-full" />
				</SheetPanel>
			</>
		))
		.onError((error) => (
			<SheetPanel>
				<ErrorState error={error} title="Failed to load the review" onRetry={refresh} />
			</SheetPanel>
		))
		.onSuccess((detail) => <ReviewDetailContent detail={detail} onSelect={onSelect} />)
		.render()
}

function ReviewDetailContent({
	detail,
	onSelect,
}: {
	detail: CodeReviewDetail
	onSelect: (reviewId: PrReviewId) => void
}) {
	const { review, report } = detail
	const outcome = outcomeOf(review)
	const lifecycle = new Map(detail.findings.map((finding) => [finding.handle, finding]))
	const durationSeconds =
		review.finishedAt === null
			? null
			: (review.finishedAt - (detail.startedAt ?? review.createdAt)) / 1000
	const problem =
		review.error ?? (review.publishError === null ? null : `Not posted to GitHub: ${review.publishError}`)

	return (
		<>
			<SheetDetailHeader
				kind={["Review", `#${review.number}`]}
				title={review.title ?? "Untitled pull request"}
				mono={false}
				description={`Review of ${review.repositoryFullName} #${review.number}`}
				meta={
					<>
						<p className="w-full text-sm text-muted-foreground">
							{review.repositoryFullName}
							{review.authorLogin ? (
								<>
									{" · opened by "}
									<AuthorLabel login={review.authorLogin} className="align-middle" />
								</>
							) : null}{" "}
							· head <TruncatedId value={review.headSha} kind="sha" />
						</p>
						<div className="flex flex-wrap gap-2 pt-1">
							<LinkButton href={review.url}>Pull request</LinkButton>
							{review.commentUrl ? (
								<LinkButton href={review.commentUrl}>Summary comment</LinkButton>
							) : null}
							{detail.reviewUrl ? (
								<LinkButton href={detail.reviewUrl}>Inline review</LinkButton>
							) : null}
							{detail.checkRunUrl ? (
								<LinkButton href={detail.checkRunUrl}>Check run</LinkButton>
							) : null}
						</div>
					</>
				}
			/>
			<SheetPanel className="flex flex-col gap-6">
				<StatRail>
					<Stat label="Outcome" value={outcome.label} tone={outcome.tone} />
					<Stat
						label="Confidence"
						value={review.confidence === null ? EMPTY_VALUE : `${review.confidence}/10`}
					/>
					<Stat
						label="Quality"
						value={review.score === null ? EMPTY_VALUE : `${review.score}/100`}
					/>
					<Stat label="Issues" value={formatCount(review.findings)} />
					<Stat label="Duration" value={formatSpan(durationSeconds)} />
					<Stat label="Model" value={modelLabel(review.model)} />
					<Stat
						label="Tokens"
						value={formatCount((detail.inputTokens ?? 0) + (detail.outputTokens ?? 0))}
					/>
					<Stat label="Reviewed" value={formatRelativeFrom(review.createdAt)} />
				</StatRail>

				{review.status === "skipped" && review.skipReason !== null ? (
					<p className="text-sm text-muted-foreground">
						Skipped: {SKIP_LABELS[review.skipReason]}.
					</p>
				) : null}
				{problem !== null ? (
					<Alert variant="crit" size="sm">
						<AlertDescription className="text-foreground">{problem}</AlertDescription>
					</Alert>
				) : null}

				{report !== null ? (
					<>
						<Section title="Summary">
							<MessageResponse mode="static" lightweight className="text-sm">
								{report.summary}
							</MessageResponse>
							{report.confidenceReason ? (
								<p className="text-xs text-muted-foreground">{report.confidenceReason}</p>
							) : null}
						</Section>
						{report.keyChanges && report.keyChanges.length > 0 ? (
							<Section title="Key changes">
								<BulletList items={report.keyChanges} />
							</Section>
						) : null}
						<Section title={`Issues (${report.findings.length})`}>
							{report.findings.length === 0 ? (
								<p className="text-sm text-muted-foreground">No issues filed on this head.</p>
							) : (
								<ul className="flex flex-col gap-3">
									{report.findings.map((finding, index) => (
										<FindingCard
											key={finding.handle ?? `${finding.path}:${finding.line}:${index}`}
											finding={finding}
											tracked={
												finding.handle ? lifecycle.get(finding.handle) : undefined
											}
										/>
									))}
								</ul>
							)}
						</Section>
						{report.telemetry !== undefined ? (
							<ProductionSection telemetry={report.telemetry} />
						) : null}
						{detail.postMerge ? <PostMergeSection postMerge={detail.postMerge} /> : null}
						{report.checked && report.checked.length > 0 ? (
							<Section title="Checked and ruled out">
								<BulletList items={report.checked} />
							</Section>
						) : null}
						{report.unreviewed && report.unreviewed.length > 0 ? (
							<Section title="Files not reviewed">
								<ul className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
									{report.unreviewed.map((path) => (
										<li key={path}>{path}</li>
									))}
								</ul>
							</Section>
						) : null}
					</>
				) : null}

				{detail.history.length > 1 ? (
					<Section title="Reviews of this pull request">
						<ul className="-mx-2 flex flex-col">
							{detail.history.map((entry) => {
								const entryOutcome = outcomeOf(entry)
								const current = entry.id === review.id
								return (
									<li key={entry.id}>
										<button
											type="button"
											disabled={current}
											onClick={() => onSelect(entry.id)}
											className={cn(
												"flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
												current ? "bg-muted" : "hover:bg-muted/60",
											)}
										>
											<TruncatedId
												value={entry.headSha}
												kind="sha"
												className="text-xs text-muted-foreground"
											/>
											<span className={cn("flex-1", entryOutcome.tone)}>
												{entryOutcome.label}
											</span>
											<span className="tabular-nums text-muted-foreground">
												{countLabel(entry.findings, "issue")}
											</span>
											<RelativeTime
												value={entry.createdAt}
												tooltip="title"
												className="w-20 text-right text-xs text-muted-foreground"
											/>
										</button>
									</li>
								)
							})}
						</ul>
					</Section>
				) : null}
			</SheetPanel>
		</>
	)
}

function FindingCard({
	finding,
	tracked,
}: {
	finding: PrReviewFinding
	tracked: CodeReviewFinding | undefined
}) {
	return (
		<li className="flex flex-col gap-2 rounded-lg border px-3.5 py-3">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
				<span className={cn("font-medium", TONE_TEXT[SEVERITY_TONE[finding.severity]])}>
					{SEVERITY_LABELS[finding.severity]}
				</span>
				<span className="text-muted-foreground">{CATEGORY_LABELS[finding.category]}</span>
				{finding.handle ? (
					<span className="font-mono text-muted-foreground">{finding.handle}</span>
				) : null}
				{tracked ? (
					<Badge variant="outline" size="sm" className="ml-auto">
						{FINDING_STATUS_LABELS[tracked.status]}
					</Badge>
				) : null}
			</div>
			<p className="text-sm font-medium">{finding.title}</p>
			<p className="font-mono text-xs text-muted-foreground">
				{finding.path}:{finding.line}
				{finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : null}
			</p>
			<MessageResponse mode="static" lightweight className="text-sm text-muted-foreground">
				{finding.body}
			</MessageResponse>
		</li>
	)
}

const modelLabel = (model: string | null) =>
	model === null ? EMPTY_VALUE : (PR_REVIEW_MODELS.find((entry) => entry.id === model)?.label ?? model)

/** A dense StatRail tile: sheet-sized value that truncates instead of overflowing. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
	return (
		<StatRailItem
			compact
			eyebrow={label}
			value={value}
			className="min-w-0 px-3 py-2.5"
			valueClassName={cn("min-w-0 shrink truncate text-sm font-medium", tone)}
		/>
	)
}

/** What production said about the change when it was reviewed. */
function ProductionSection({ telemetry }: { telemetry: PrReviewTelemetry }) {
	const breaks = telemetry.contractBreaks
	if (breaks.length === 0 && telemetry.linkedIssues.length === 0 && telemetry.hotFiles.length === 0)
		return null
	return (
		<Section title="Production impact">
			{breaks.length > 0 ? (
				<ul className="flex flex-col gap-1.5 text-sm">
					{breaks.map((item) => (
						<li
							key={`${item.kind}:${item.name}`}
							className={item.dismissed ? "text-muted-foreground" : undefined}
						>
							<span className={cn("font-medium", item.dismissed ? undefined : TONE_TEXT.crit)}>
								{item.dismissed ? "Still emitted elsewhere" : "Stops arriving"}
							</span>{" "}
							<code className="font-mono text-xs">{item.name}</code> ·{" "}
							{item.references.map((ref) => `${ref.kind} “${ref.name}”`).join(", ")}
						</li>
					))}
				</ul>
			) : null}
			{telemetry.linkedIssues.length > 0 ? (
				<BulletList
					items={telemetry.linkedIssues.map(
						(issue) =>
							`Open error in ${issue.path}: ${issue.title} (${formatCount(issue.occurrences)} occurrences)`,
					)}
				/>
			) : null}
			{telemetry.hotFiles.length > 0 ? (
				<BulletList
					items={telemetry.hotFiles
						.slice(0, 5)
						.map(
							(file) =>
								`${file.path}: ${formatCount(file.perDay)} calls/day (${file.operations[0]?.spanName ?? ""})`,
						)}
				/>
			) : null}
		</Section>
	)
}

/** How the operations the change touched behaved the hour before and after it deployed. */
function PostMergeSection({ postMerge }: { postMerge: PrReviewPostMerge }) {
	const regressed = postMerge.verdict === "regressed"
	return (
		<Section title="After it shipped">
			<p className={cn("text-sm", regressed ? TONE_TEXT.warn : "text-muted-foreground")}>
				{regressed ? "Something changed after this deployed" : "Shipped clean"} ·{" "}
				{postMerge.deploy.service}{" "}
				<TruncatedId value={postMerge.deploy.commitSha} kind="sha" className="text-xs" />{" "}
				{formatRelativeFrom(DateTime.toEpochMillis(postMerge.deploy.firstSeen))}
			</p>
			<BulletList
				items={[
					...postMerge.missing.map((name) => `${name} stopped arriving`),
					...postMerge.newIssues.map(
						(issue) => `New error: ${issue.title} (${issue.afterPerHour}/h)`,
					),
					...postMerge.linkedIssues.map(
						(issue) => `${issue.title}: ${issue.beforePerHour}/h → ${issue.afterPerHour}/h`,
					),
					...postMerge.operations
						.filter((operation) => operation.regressed)
						.map(
							(operation) =>
								`${operation.spanName}: errors ${(operation.before.errorRate * 100).toFixed(1)}% → ${(operation.after.errorRate * 100).toFixed(1)}%, p95 ${operation.before.p95Ms} → ${operation.after.p95Ms} ms`,
						),
				]}
			/>
		</Section>
	)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2.5">
			<SectionHeading title={title} as="h3" />
			{children}
		</section>
	)
}

function BulletList({ items }: { items: ReadonlyArray<string> }) {
	return (
		<ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground marker:text-muted-foreground/50">
			{items.map((item, index) => (
				<li key={index}>{item}</li>
			))}
		</ul>
	)
}

function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<Button variant="outline" size="xs" render={<a href={href} target="_blank" rel="noreferrer" />}>
			{children}
			<ExternalLinkIcon size={12} aria-hidden />
		</Button>
	)
}
