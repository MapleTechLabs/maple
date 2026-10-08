import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import { shortId } from "@maple/ui/lib/ids"
import { RelativeTime } from "@/components/common/relative-time"
import { cn } from "@maple/ui/lib/utils"

import {
	CommitAvatar,
	CommitShaHoverCard,
	commitQueryAtom,
	firstLine,
	isResolvableSha,
} from "@/components/vcs/commit-sha-hover-card"
import type { ReleasePoint } from "@/components/vcs/commit-markers/marker-layout"
import { DocsLink } from "@/components/common/docs-link"
import { ResultView } from "@/components/common/result-view"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { formatErrorRate, formatNumber, pluralize } from "@maple/ui/lib/format"
import { errorRateLevel } from "@maple/ui/lib/error-rate"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { Badge } from "@maple/ui/components/ui/badge"
import { SectionCard } from "./section-card"
import { shortReleaseLabel } from "@/components/releases/release-model"
import { InlineCode } from "@maple/ui/components/ui/inline-code"
import { EmptyMessage } from "@maple/ui/components/ui/empty"

const RAIL_LIMIT = 8
// Expanded ceiling: bounds mounted commit-resolution subscriptions when a window
// holds hundreds of versions. The tail is summarized in a final count row.
const EXPANDED_LIMIT = 50

interface ServiceRecentDeploysProps {
	/** The per-bucket release timeline the Overview already fetched. */
	releases: ReadonlyArray<ReleasePoint>
	/** True while the overview query is still in flight (no retained data yet). */
	isLoading?: boolean
}

interface DeployEntry {
	sha: string
	/** First bucket the commit was seen in — its deploy time, as the data can tell. */
	firstSeen: string
	/** Total spans attributed to the commit across the window. */
	spanCount: number
	/** Error-status spans attributed to the commit across the window. */
	errorCount: number
}

function deriveDeploys(releases: ReadonlyArray<ReleasePoint>): DeployEntry[] {
	const bySha = new Map<string, DeployEntry>()
	for (const point of releases) {
		const existing = bySha.get(point.commitSha)
		if (existing === undefined) {
			bySha.set(point.commitSha, {
				sha: point.commitSha,
				firstSeen: point.bucket,
				spanCount: point.count,
				errorCount: point.errorCount ?? 0,
			})
		} else {
			existing.spanCount += point.count
			existing.errorCount += point.errorCount ?? 0
			if (point.bucket < existing.firstSeen) existing.firstSeen = point.bucket
		}
	}
	return [...bySha.values()].toSorted((a, b) =>
		a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0,
	)
}

/**
 * Per-version error-rate chip. Window-wide rate (errors / spans while this
 * version served traffic), not a deploy-impact delta — the tooltip says so.
 * Rendered even at ~0% so a healthy deploy reads as confirmed-healthy rather
 * than missing data.
 */
function ErrorRateChip({ errorCount, spanCount }: { errorCount: number; spanCount: number }) {
	if (spanCount <= 0) return null
	const ratio = errorCount / spanCount
	const level = errorRateLevel(ratio)
	return (
		<Badge
			size="xs"
			mono
			title={`${formatNumber(errorCount)} errors of ${formatNumber(spanCount)} spans while this version served traffic`}
			className={cn(
				"cursor-default",
				level === "neutral" ? "bg-transparent text-muted-foreground/60" : TONE_SOFT[level],
			)}
		>
			{formatErrorRate(ratio)}
		</Badge>
	)
}

/** The shared two-line row scaffold: avatar · [line1 / line2] with the chip and
 * age pinned to their respective line ends. */
function RowFrame({
	avatar,
	line1,
	chip,
	line2,
}: {
	avatar: React.ReactNode
	line1: React.ReactNode
	chip?: React.ReactNode
	line2: React.ReactNode
}) {
	return (
		<div className="flex items-start gap-2.5 rounded-sm px-2 py-1.5">
			<div className="mt-0.5 shrink-0">{avatar}</div>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
				<div className="flex items-center gap-2">
					<div className="min-w-0 flex-1 truncate text-[13px]">{line1}</div>
					{chip}
				</div>
				<div className="flex items-baseline gap-1.5 text-2xs text-muted-foreground">{line2}</div>
			</div>
		</div>
	)
}

function RowMeta({ deploy, prefix }: { deploy: DeployEntry; prefix?: React.ReactNode }) {
	return (
		<>
			{prefix}
			<span className="shrink-0 tabular-nums">{formatNumber(deploy.spanCount)} spans</span>
			<RelativeTime
				value={deploy.firstSeen}
				variant="orDate"
				mono
				tooltip="title"
				className="ml-auto shrink-0 cursor-default text-muted-foreground/70"
			/>
		</>
	)
}

/** Non-resolvable reference (tag, short sha, arbitrary telemetry): verbatim mono
 * label, no fetch, no hover card. */
function DeployRowPlain({ deploy }: { deploy: DeployEntry }) {
	const label = shortId(deploy.sha, "generic", { length: 24, ellipsis: true })
	return (
		<RowFrame
			avatar={<span className="block size-5 rounded-full bg-muted" />}
			line1={<span className="font-mono text-xs text-foreground">{label}</span>}
			chip={<ErrorRateChip errorCount={deploy.errorCount} spanCount={deploy.spanCount} />}
			line2={
				<RowMeta deploy={deploy} prefix={<span className="shrink-0">deployment reference</span>} />
			}
		/>
	)
}

/** Resolvable SHA whose commit couldn't be loaded (repo not connected, revoked
 * access, …): sha-first fallback. The hover card carries the explanation + CTA. */
function DeployRowFallback({ deploy }: { deploy: DeployEntry }) {
	return (
		<RowFrame
			avatar={<span className="block size-5 rounded-full bg-muted" />}
			line1={
				<CommitShaHoverCard sha={deploy.sha} className="font-mono text-xs text-foreground">
					{shortReleaseLabel(deploy.sha)}
				</CommitShaHoverCard>
			}
			chip={<ErrorRateChip errorCount={deploy.errorCount} spanCount={deploy.spanCount} />}
			line2={<RowMeta deploy={deploy} prefix={<span className="shrink-0">commit unresolved</span>} />}
		/>
	)
}

function DeployRowSkeleton() {
	return (
		<div className="flex items-start gap-2.5 px-2 py-1.5">
			<Skeleton className="mt-0.5 size-5 shrink-0 rounded-full" />
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<Skeleton className="h-3.5 w-3/4" />
				<Skeleton className="h-3 w-1/2" />
			</div>
		</div>
	)
}

function DeployRowResolved({ deploy }: { deploy: DeployEntry }) {
	const result = useAtomValue(commitQueryAtom(deploy.sha))
	return (
		<ResultView
			result={result}
			loading={<DeployRowSkeleton />}
			error={() => <DeployRowFallback deploy={deploy} />}
		>
			{(commit) => {
				const author = commit.authorLogin ?? commit.authorName ?? "Unknown author"
				return (
					<RowFrame
						avatar={<CommitAvatar url={commit.authorAvatarUrl} name={author} compact />}
						line1={
							<CommitShaHoverCard sha={deploy.sha} className="text-foreground">
								{firstLine(commit.message)}
							</CommitShaHoverCard>
						}
						chip={<ErrorRateChip errorCount={deploy.errorCount} spanCount={deploy.spanCount} />}
						line2={
							<RowMeta
								deploy={deploy}
								prefix={
									<>
										<span className="min-w-0 truncate">{author}</span>
										<TruncatedId value={deploy.sha} kind="sha" className="shrink-0" />
									</>
								}
							/>
						}
					/>
				)
			}}
		</ResultView>
	)
}

function DeployRow({ deploy }: { deploy: DeployEntry }) {
	return isResolvableSha(deploy.sha) ? (
		<DeployRowResolved deploy={deploy} />
	) : (
		<DeployRowPlain deploy={deploy} />
	)
}

// Error tags that mean "no VCS provider is connected at all" — the one case that
// deserves a single panel-level CTA instead of N per-row fallbacks.
function isNotConnectedError(error: unknown): boolean {
	const tag =
		typeof error === "object" && error !== null && "_tag" in error
			? String((error as { _tag: unknown })._tag)
			: ""
	return tag.endsWith("IntegrationsNotConnectedError")
}

/** Watches the first resolvable sha's (shared, cached) resolution; when it fails
 * with not-connected, offers ONE footer CTA for the whole panel. */
function ConnectRepoFooter({ sha }: { sha: string }) {
	const result = useAtomValue(commitQueryAtom(sha))
	const notConnected = Result.builder(result)
		.onError((error) => isNotConnectedError(error))
		.orElse(() => false)
	if (!notConnected) return null
	return (
		<div className="border-t px-4 py-2 text-xs">
			<Link
				to="/integrations"
				className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
			>
				Connect a repository to resolve commits
				<span aria-hidden>→</span>
			</Link>
		</div>
	)
}

/**
 * "Recent deploys" rail: the versions behind the chart's deploy markers, newest
 * first — commit-message-first rows (author avatar · subject · error-rate chip),
 * each hover-expandable to the resolved commit card. Derived purely from the
 * release timeline the Overview tab already has; commit details resolve through
 * the same per-sha cached atom the markers use.
 */
export function ServiceRecentDeploys({ releases, isLoading = false }: ServiceRecentDeploysProps) {
	const deploys = useMemo(() => deriveDeploys(releases), [releases])
	const [expanded, setExpanded] = useState(false)
	const visible = expanded ? deploys.slice(0, EXPANDED_LIMIT) : deploys.slice(0, RAIL_LIMIT)
	const hiddenCount = deploys.length - visible.length
	const firstResolvable = deploys.find((deploy) => isResolvableSha(deploy.sha))

	if (isLoading) {
		return (
			<SectionCard title="Recent deploys">
				<SkeletonList rows={4} renderRow={() => <DeployRowSkeleton />} className="p-2" />
			</SectionCard>
		)
	}

	return (
		<SectionCard
			title="Recent deploys"
			action={
				deploys.length > 0 ? (
					<span className="text-xs text-muted-foreground/70">
						{deploys.length === 1 ? "1 version" : `${deploys.length} versions`} in window
					</span>
				) : undefined
			}
		>
			{deploys.length === 0 ? (
				<EmptyMessage className="flex flex-col items-center gap-1">
					<span>No deploys detected in this window.</span>
					<span className="text-muted-foreground/70">
						Deploy tracking needs spans to carry the{" "}
						<InlineCode>vcs.ref.head.revision</InlineCode> resource attribute.
					</span>
					<span className="mt-1">
						<DocsLink page="github" />
					</span>
				</EmptyMessage>
			) : (
				<>
					<div className={cn("space-y-px p-2", expanded && "max-h-96 overflow-y-auto")}>
						{visible.map((deploy) => (
							<DeployRow key={deploy.sha} deploy={deploy} />
						))}
						{expanded && hiddenCount > 0 ? (
							<div className="px-2 py-1.5 text-center text-2xs text-muted-foreground/70">
								…and {hiddenCount} more {pluralize(hiddenCount, "version")} in this window
							</div>
						) : null}
					</div>
					{deploys.length > RAIL_LIMIT ? (
						<button
							type="button"
							onClick={() => setExpanded((v) => !v)}
							className="w-full border-t px-4 py-2 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							{expanded
								? "Show fewer"
								: deploys.length <= EXPANDED_LIMIT
									? `Show all ${deploys.length} deploys`
									: `Show latest ${EXPANDED_LIMIT} deploys`}
						</button>
					) : null}
					{firstResolvable ? <ConnectRepoFooter sha={firstResolvable.sha} /> : null}
				</>
			)}
		</SectionCard>
	)
}
