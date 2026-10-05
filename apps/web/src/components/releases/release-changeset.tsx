import type React from "react"
import { useMemo } from "react"
import type { VcsCommitRangeResponse } from "@maple/domain/http"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"

import { SectionCard } from "@/components/services/section-card"
import { CommitAvatar, firstLine, isResolvableSha } from "@/components/vcs/commit-sha-hover-card"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { Atom, Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQuery } from "@/lib/services/common/atom-client"
import { shortReleaseLabel } from "./release-model"
import { EmptyMessage } from "@maple/ui/components/ui/empty"

const RANGE_TTL_MS = 5 * 60_000
/** The list only needs counts; the detail card lists this many commits. */
const DETAIL_COMMIT_LIMIT = 100

export interface CommitRange {
	readonly base: string
	readonly head: string
}

/** Canonical key for a set of ranges: resolvable pairs only, deduped and sorted. */
export const commitRangesKey = (ranges: Iterable<CommitRange>): string =>
	[
		...new Set(
			[...ranges]
				.filter((range) => isResolvableSha(range.base) && isResolvableSha(range.head))
				.map((range) => `${range.base}..${range.head}`),
		),
	]
		.sort()
		.join(",")

const commitRangesAtom = Atom.family((key: string) => {
	const [rangesKey, limit] = key.split("|")
	return retainedQuery("integrations", "vcsCommitRanges", {
		query: { ranges: rangesKey ?? "", limit: Number(limit ?? 0) },
		timeToLive: RANGE_TTL_MS,
	})
})

const EMPTY_RANGES: ReadonlyMap<string, VcsCommitRangeResponse> = new Map()

/**
 * Resolves many ranges in one request and hands them to `children`, keyed by
 * head sha. Never blocks paint: until it resolves the map is empty.
 */
export function ResolvedCommitRanges({
	ranges,
	children,
}: {
	ranges: ReadonlyArray<CommitRange>
	children: (resolved: ReadonlyMap<string, VcsCommitRangeResponse>) => React.ReactNode
}) {
	const key = useMemo(() => commitRangesKey(ranges), [ranges])
	if (key === "") return <>{children(EMPTY_RANGES)}</>
	return <ResolvedCommitRangesLoaded rangesKey={key}>{children}</ResolvedCommitRangesLoaded>
}

function ResolvedCommitRangesLoaded({
	rangesKey,
	children,
}: {
	rangesKey: string
	children: (resolved: ReadonlyMap<string, VcsCommitRangeResponse>) => React.ReactNode
}) {
	const result = useAtomValue(commitRangesAtom(`${rangesKey}|0`))
	const resolved = useMemo(
		() =>
			Result.isSuccess(result)
				? new Map(
						result.value.ranges
							.filter((range) => range.status === "resolved")
							.map((range) => [range.head, range]),
					)
				: EMPTY_RANGES,
		[result],
	)
	return <>{children(resolved)}</>
}

/** "12 commits": shown only when a deploy carried more than its head commit. */
export function CommitCount({ range }: { range: VcsCommitRangeResponse | undefined }) {
	if (range === undefined || range.totalCount < 2) return null
	return (
		<span className="tabular-nums" title={`Commits since ${shortReleaseLabel(range.base)}`}>
			{range.totalCount}
			{range.truncated ? "+" : ""} commits
		</span>
	)
}

/** `(#1083)` at the end of a squash-merge subject, linked to the pull request. */
function pullRequestUrl(subject: string, commitUrl: string): { number: string; url: string } | undefined {
	const match = subject.match(/\(#(\d+)\)\s*$/)
	const repoUrl = commitUrl.match(/^(.*)\/commit\/[0-9a-f]+$/i)?.[1]
	if (match?.[1] === undefined || repoUrl === undefined) return undefined
	return { number: match[1], url: `${repoUrl}/pull/${match[1]}` }
}

/** Every commit the release carried over the version it replaced. */
export function ReleaseChangeset({ base, head }: { base: string | undefined; head: string }) {
	if (base === undefined) {
		return (
			<SectionCard title="What shipped">
				<EmptyMessage>No earlier version in this window to compare against.</EmptyMessage>
			</SectionCard>
		)
	}
	const key = commitRangesKey([{ base, head }])
	if (key === "") {
		return (
			<SectionCard title="What shipped">
				<EmptyMessage>
					These versions are not commit shas, so the commits between them are unknown.
				</EmptyMessage>
			</SectionCard>
		)
	}
	return <ReleaseChangesetLoaded rangesKey={key} base={base} />
}

function ReleaseChangesetLoaded({ rangesKey, base }: { rangesKey: string; base: string }) {
	const { effectiveTimezone } = useTimezonePreference()
	const result = useAtomValue(commitRangesAtom(`${rangesKey}|${DETAIL_COMMIT_LIMIT}`))
	const range = Result.isSuccess(result) ? result.value.ranges[0] : undefined

	const action = (
		<span className="text-[11px] text-muted-foreground/70">
			since <span className="font-mono">{shortReleaseLabel(base)}</span>
		</span>
	)

	if (Result.isInitial(result)) {
		return (
			<SectionCard title="What shipped" action={action}>
				<div className="space-y-2 p-3">
					<Skeleton className="h-4 w-3/4" />
					<Skeleton className="h-4 w-1/2" />
				</div>
			</SectionCard>
		)
	}
	if (range === undefined || range.status === "unavailable") {
		return (
			<SectionCard title="What shipped" action={action}>
				<EmptyMessage>
					Both versions need to be commits of a connected repository's tracked branch to list what
					changed between them.
				</EmptyMessage>
			</SectionCard>
		)
	}

	const hidden = range.totalCount - range.commits.length
	return (
		<SectionCard
			title={`What shipped · ${range.totalCount}${range.truncated ? "+" : ""} ${range.totalCount === 1 ? "commit" : "commits"}`}
			action={action}
		>
			<div className="max-h-80 overflow-y-auto">
				{range.commits.map((commit) => {
					const subject = firstLine(commit.message)
					const pr = pullRequestUrl(subject, commit.htmlUrl)
					const author = commit.authorLogin ?? commit.authorName ?? "Unknown author"
					return (
						<div
							key={commit.sha}
							className="flex items-start gap-2.5 border-t border-border/60 px-4 py-2 text-xs first:border-t-0"
						>
							<div className="mt-px shrink-0">
								<CommitAvatar url={commit.authorAvatarUrl} name={author} compact />
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<a
									href={pr?.url ?? commit.htmlUrl}
									target="_blank"
									rel="noreferrer"
									className="truncate text-foreground hover:underline"
								>
									{subject}
								</a>
								<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
									<span className="font-mono">{shortReleaseLabel(commit.sha)}</span>
									<span className="truncate">{author}</span>
								</span>
							</div>
							<span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">
								{formatRelativeTimeOrDate(
									new Date(commit.committedAt).toISOString(),
									undefined,
									effectiveTimezone,
								)}
							</span>
						</div>
					)
				})}
				{hidden > 0 ? (
					<div className="border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground/70">
						{hidden} older {hidden === 1 ? "commit" : "commits"} not shown
					</div>
				) : null}
			</div>
		</SectionCard>
	)
}
