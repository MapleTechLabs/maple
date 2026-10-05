import { Link } from "@tanstack/react-router"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { buildServiceOpenIssuesQuery, errorIssueFromV2 } from "@/lib/services/error-issues"
import { SectionCard } from "./section-card"
import { IssueLine } from "./issue-line"
import { EmptyMessage } from "@maple/ui/components/ui/empty"

interface ServiceErrorsPanelProps {
	serviceName: string
	effectiveStartTime: string
	effectiveEndTime: string
	/** Page-level env filter (single-element by convention, see the route). */
	environments?: string[]
}

function PanelFrame({ children, detailLimited }: { children: React.ReactNode; detailLimited?: boolean }) {
	return (
		<SectionCard
			title="Open issues"
			action={
				<div className="flex items-center gap-3">
					{detailLimited && (
						<span className="text-[11px] text-muted-foreground">Latest 90 days</span>
					)}
					{/* `/errors/issues` now 302s to `/errors` and rewrites the time range
					    to 7d on the way through. Link to the hub directly. */}
					<Link to="/errors" className="text-xs text-primary hover:underline">
						View all →
					</Link>
				</div>
			}
		>
			{children}
		</SectionCard>
	)
}

function PanelSkeleton() {
	return (
		<PanelFrame>
			<div className="space-y-px p-2">
				{Array.from({ length: 4 }).map((_, i) => (
					<Skeleton key={i} className="h-8 w-full" />
				))}
			</div>
		</PanelFrame>
	)
}

function PanelReady({
	issues,
	detailLimited,
}: {
	issues: ReadonlyArray<ErrorIssueDocument>
	detailLimited: boolean
}) {
	return (
		<PanelFrame detailLimited={detailLimited}>
			{issues.length === 0 ? (
				<EmptyMessage>No open issues for this service.</EmptyMessage>
			) : (
				<div className="space-y-px p-2">
					{issues.map((issue) => (
						<IssueLine key={issue.id} issue={issue} />
					))}
				</div>
			)}
		</PanelFrame>
	)
}

export function ServiceErrorsPanel({
	serviceName,
	effectiveStartTime,
	effectiveEndTime,
	environments,
}: ServiceErrorsPanelProps) {
	// Only a single selected environment scopes the list (matching the switcher's
	// single-select semantics); the page window rides along so the filter means
	// "issues seen in this environment in this window".
	const environment = environments?.length === 1 ? environments[0] : undefined
	const detailLimited =
		Date.parse(effectiveEndTime) - Date.parse(effectiveStartTime) > 90 * 24 * 60 * 60 * 1000
	const detailStartTime = detailLimited
		? new Date(Date.parse(effectiveEndTime) - 90 * 24 * 60 * 60 * 1000).toISOString()
		: effectiveStartTime
	const result = useAtomValue(
		retainedQueryV2("errorIssues", "list", {
			query: buildServiceOpenIssuesQuery(serviceName, {
				environment,
				startTime: detailStartTime,
				endTime: effectiveEndTime,
			}),
			reactivityKeys: ["errorIssues"],
		}),
	)
	if (Result.isInitial(result)) return <PanelSkeleton />
	if (Result.isFailure(result)) {
		return (
			<PanelFrame>
				<EmptyMessage>Issues could not be loaded.</EmptyMessage>
			</PanelFrame>
		)
	}
	return <PanelReady issues={result.value.data.map(errorIssueFromV2)} detailLimited={detailLimited} />
}
