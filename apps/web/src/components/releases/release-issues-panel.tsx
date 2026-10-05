import { useMemo } from "react"
import type { ErrorIssueDocument } from "@maple/domain/http"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { SectionCard } from "@/components/services/section-card"
import { IssueLine } from "@/components/services/issue-line"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { errorIssueFromV2 } from "@/lib/services/error-issues"
import type { ReleaseErrorFingerprint } from "@/api/warehouse/releases"
import { NEW_ISSUE_SLACK_MS } from "./release-model"
import { EmptyMessage } from "@maple/ui/components/ui/empty"

/** The v2 list takes one page of fingerprints; the rest of a very noisy version stays on /errors. */
const FINGERPRINT_LIMIT = 50

/** The two timestamps the split reads; the panel passes whole issue documents. */
export interface ReleaseIssueDates {
	readonly firstSeenAt: string
	readonly lastRegressedAt: string | null
}

export interface ReleaseIssueSplit<T extends ReleaseIssueDates> {
	/** Issues whose first occurrence anywhere came with this version. */
	fresh: T[]
	/** Issues that had been fixed and came back with this version. */
	regressed: T[]
	/** Issues that were already open and are still occurring on this version. */
	ongoing: T[]
}

/** Exported for its tests — the panel below is the only production caller. */
export function splitReleaseIssues<T extends ReleaseIssueDates>(
	issues: ReadonlyArray<T>,
	releaseFirstSeen: string,
): ReleaseIssueSplit<T> {
	const cutoff = Date.parse(releaseFirstSeen) - NEW_ISSUE_SLACK_MS
	const split: ReleaseIssueSplit<T> = { fresh: [], regressed: [], ongoing: [] }
	for (const issue of issues) {
		if (Date.parse(issue.firstSeenAt) >= cutoff) split.fresh.push(issue)
		else if (issue.lastRegressedAt !== null && Date.parse(issue.lastRegressedAt) >= cutoff)
			split.regressed.push(issue)
		else split.ongoing.push(issue)
	}
	return split
}

export function IssueList({
	title,
	issues,
	counts,
	empty,
	tone,
	showService,
}: {
	title: string
	issues: ReadonlyArray<ErrorIssueDocument>
	counts: ReadonlyMap<string, number>
	empty: string
	tone?: "error" | "warn"
	/** Marks each line with its service, for a release spanning several. */
	showService?: boolean
}) {
	return (
		<SectionCard
			title={title}
			action={
				<span
					className={
						issues.length === 0
							? "text-[11px] text-muted-foreground/70"
							: tone === "error"
								? "text-[11px] font-medium text-severity-error"
								: tone === "warn"
									? "text-[11px] font-medium text-severity-warn"
									: "text-[11px] text-muted-foreground"
					}
				>
					{issues.length}
				</span>
			}
		>
			{issues.length === 0 ? (
				<EmptyMessage>{empty}</EmptyMessage>
			) : (
				<div className="space-y-px p-2">
					{issues.map((issue) => (
						<IssueLine
							key={issue.id}
							issue={issue}
							occurrences={counts.get(issue.fingerprintHash)}
							occurrencesTitle="Occurrences on this version in the window"
							showService={showService}
						/>
					))}
				</div>
			)}
		</SectionCard>
	)
}

function PanelsSkeleton() {
	return (
		<div className="grid gap-3 lg:grid-cols-3">
			{["New on this version", "Regressed on this version", "Still occurring"].map((title) => (
				<SectionCard key={title} title={title}>
					<div className="space-y-px p-2">
						{Array.from({ length: 3 }).map((_, i) => (
							<Skeleton key={i} className="h-8 w-full" />
						))}
					</div>
				</SectionCard>
			))}
		</div>
	)
}

interface ReleaseIssuesPanelProps {
	serviceName: string
	releaseFirstSeen: string
	fingerprints: ReadonlyArray<ReleaseErrorFingerprint>
}

/**
 * The bridge from a release to the issues system: every fingerprint whose
 * occurrences carried this version as `service.version`, split into new,
 * regressed and ongoing against the release's first-seen. The warehouse half
 * comes with the detail bundle; the issue documents are one v2 list call
 * keyed on those fingerprints.
 */
export function ReleaseIssuesPanel({ serviceName, releaseFirstSeen, fingerprints }: ReleaseIssuesPanelProps) {
	if (fingerprints.length === 0) {
		return (
			<div className="grid gap-3 lg:grid-cols-3">
				<IssueList
					title="New on this version"
					issues={[]}
					counts={new Map()}
					empty="No errors carried this version."
				/>
				<IssueList
					title="Regressed on this version"
					issues={[]}
					counts={new Map()}
					empty="Nothing fixed before has come back."
				/>
				<IssueList
					title="Still occurring"
					issues={[]}
					counts={new Map()}
					empty="No open issue occurred on this version."
				/>
			</div>
		)
	}
	return (
		<ReleaseIssuesLoaded
			serviceName={serviceName}
			releaseFirstSeen={releaseFirstSeen}
			fingerprints={fingerprints}
		/>
	)
}

function ReleaseIssuesLoaded({ serviceName, releaseFirstSeen, fingerprints }: ReleaseIssuesPanelProps) {
	const page = fingerprints.slice(0, FINGERPRINT_LIMIT)
	const counts = useMemo(() => new Map(page.map((row) => [row.fingerprintHash, row.count])), [page])
	const result = useAtomValue(
		retainedQueryV2("errorIssues", "list", {
			query: {
				service_name: serviceName,
				fingerprint_hash: page.map((row) => row.fingerprintHash).join(","),
				limit: FINGERPRINT_LIMIT,
			},
			reactivityKeys: ["errorIssues"],
		}),
	)

	const split = useMemo(
		() =>
			Result.isSuccess(result)
				? splitReleaseIssues(result.value.data.map(errorIssueFromV2), releaseFirstSeen)
				: undefined,
		[result, releaseFirstSeen],
	)

	if (Result.isInitial(result)) return <PanelsSkeleton />
	if (split === undefined) {
		return <EmptyMessage className="rounded-md border bg-card">Issues could not be loaded.</EmptyMessage>
	}

	return (
		<div className="grid gap-3 lg:grid-cols-3">
			<IssueList
				title="New on this version"
				issues={split.fresh}
				counts={counts}
				empty="No issue first appeared with this version."
				tone="error"
			/>
			<IssueList
				title="Regressed on this version"
				issues={split.regressed}
				counts={counts}
				empty="Nothing fixed before has come back."
				tone="warn"
			/>
			<IssueList
				title="Still occurring"
				issues={split.ongoing}
				counts={counts}
				empty="No older issue occurred on this version."
			/>
		</div>
	)
}
