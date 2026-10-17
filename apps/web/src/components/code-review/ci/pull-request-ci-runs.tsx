import { useState, type ReactNode } from "react"
import type { VcsRepositoryId } from "@maple/domain/http"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import { formatDuration } from "@maple/ui/lib/format"

import { SectionHeading } from "@/components/common/section-heading"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedInternalQuery } from "@/lib/services/common/internal-atom-client"

import { CiResultBadge } from "./ci-result-badge"
import { TraceLink } from "./ci-runs-list"

const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000
const MINUTE_MS = 60_000
const SHOWN = 20

/** A pull request's CI runs over the last two weeks, the most the CI reads cover. */
export function PullRequestCiRuns({
	repositoryId,
	pullRequest,
}: {
	repositoryId: VcsRepositoryId
	pullRequest: number
}) {
	// Read once per sheet and snapped to the minute, so reopening the sheet reuses the query.
	const [now] = useState(() => Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS)
	const result = useAtomValue(
		retainedInternalQuery("codeReview", "ciRuns", {
			query: { startTime: now - LOOKBACK_MS, endTime: now, repositoryId, pullRequest, limit: SHOWN },
		}),
	)

	return Result.builder(result)
		.onSuccess((response) =>
			response.runs.length === 0 ? (
				<Section>
					<p className="text-sm text-muted-foreground">No CI runs in the last two weeks</p>
				</Section>
			) : (
				<Section>
					<ul className="-mx-2 flex flex-col">
						{response.runs.map((run) => (
							<li
								key={run.traceId}
								className="flex items-center gap-3 rounded-md px-2 py-1 text-sm hover:bg-muted/60"
							>
								<CiResultBadge
									result={run.result}
									attempt={run.attempt}
									className="w-32 shrink-0"
								/>
								<span className="min-w-0 flex-1 truncate" title={run.pipeline}>
									{run.pipeline}
								</span>
								<TruncatedId
									value={run.revision}
									kind="sha"
									className="text-xs text-muted-foreground"
								/>
								<span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
									{formatDuration(run.durationMs)}
								</span>
								<TraceLink run={run} className="shrink-0" />
							</li>
						))}
					</ul>
					{response.nextCursor === null ? null : (
						<p className="text-xs text-muted-foreground">Latest {SHOWN} runs</p>
					)}
				</Section>
			),
		)
		.onError(() => (
			<Section>
				<p className="text-sm text-muted-foreground">CI runs could not be loaded</p>
			</Section>
		))
		.orElse(() => (
			<Section>
				<Skeleton className="h-16 w-full" />
			</Section>
		))
}

function Section({ children }: { children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2.5">
			<SectionHeading title="CI runs" as="h3" />
			{children}
		</section>
	)
}
