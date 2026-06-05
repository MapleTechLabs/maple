import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Exit, Schema } from "effect"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { IssueCommentComposer } from "@/components/errors/issue-comment-composer"
import { IssueHero } from "@/components/errors/issue-hero"
import { IssueIncidentsTable } from "@/components/errors/issue-incidents-table"
import { IssueOccurrenceSparkline } from "@/components/errors/issue-occurrence-sparkline"
import { IssueOccurrencesTable } from "@/components/errors/issue-occurrences-table"
import { IssueSidebar } from "@/components/errors/issue-sidebar"
import { IssueTimeline } from "@/components/errors/issue-timeline"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card, CardContent } from "@maple/ui/components/ui/card"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { ErrorIssueId, type LinkedAlertIncidentDocument, type WorkflowState } from "@maple/domain/http"
import { formatAlertDateTimeFull, formatSignalValue, signalLabels } from "@/lib/alerts/form-utils"

const decodeIssueId = Schema.decodeSync(ErrorIssueId)

export const Route = effectRoute(createFileRoute("/errors/issues/$issueId"))({
	component: IssueDetailPage,
})

const WORKFLOW_BADGE: Record<WorkflowState, { label: string; tone: string }> = {
	triage: {
		label: "Triage",
		tone: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	},
	todo: { label: "Todo", tone: "bg-muted text-muted-foreground" },
	in_progress: {
		label: "In progress",
		tone: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
	},
	in_review: {
		label: "In review",
		tone: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
	},
	done: { label: "Done", tone: "bg-success/10 text-success" },
	cancelled: { label: "Cancelled", tone: "bg-muted text-muted-foreground" },
	wontfix: { label: "Wontfix", tone: "bg-muted text-muted-foreground" },
}

function WorkflowBadge({ state }: { state: WorkflowState }) {
	const { label, tone } = WORKFLOW_BADGE[state]
	return (
		<Badge variant="outline" className={tone}>
			{label}
		</Badge>
	)
}

function SectionHeader({ id, label }: { id: string; label: string }) {
	return (
		<h2
			id={id}
			className="mb-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
		>
			{label}
		</h2>
	)
}

function IssueDetailPage() {
	const { issueId: rawIssueId } = Route.useParams()
	const issueId = decodeIssueId(rawIssueId)

	const detailQueryAtom = MapleApiAtomClient.query("errors", "getIssue", {
		params: { issueId },
		query: {},
		reactivityKeys: ["errorIssues", `errorIssue:${issueId}`],
	})
	const detailResult = useAtomValue(detailQueryAtom)

	const eventsQueryAtom = MapleApiAtomClient.query("errors", "listIssueEvents", {
		params: { issueId },
		query: { limit: 200 },
		reactivityKeys: ["errorIssues", `errorIssue:${issueId}:events`],
	})
	const eventsResult = useAtomValue(eventsQueryAtom)

	const transitionIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "transitionIssue"), {
		mode: "promiseExit",
	})
	const claimIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "claimIssue"), {
		mode: "promiseExit",
	})
	const heartbeatIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "heartbeatIssue"), {
		mode: "promiseExit",
	})
	const releaseIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "releaseIssue"), {
		mode: "promiseExit",
	})
	const commentOnIssue = useAtomSet(MapleApiAtomClient.mutation("errors", "commentOnIssue"), {
		mode: "promiseExit",
	})

	const [commentDraft, setCommentDraft] = useState("")
	const [busy, setBusy] = useState<"state" | "claim" | "release" | "heartbeat" | "comment" | null>(null)

	const invalidateKeys = useMemo(
		() => ["errorIssues", `errorIssue:${issueId}`, `errorIssue:${issueId}:events`],
		[issueId],
	)

	const transitionTo = async (next: WorkflowState) => {
		setBusy("state")
		const result = await transitionIssue({
			params: { issueId },
			payload: { toState: next },
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toast.success(`Moved to ${next}`)
		else toast.error("State change failed")
	}

	const claim = async () => {
		setBusy("claim")
		const result = await claimIssue({
			params: { issueId },
			payload: {},
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toast.success("Claimed")
		else toast.error("Claim failed")
	}

	const heartbeat = async () => {
		setBusy("heartbeat")
		const result = await heartbeatIssue({
			params: { issueId },
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toast.success("Lease extended")
		else toast.error("Heartbeat failed")
	}

	const release = async () => {
		setBusy("release")
		const result = await releaseIssue({
			params: { issueId },
			payload: {},
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) toast.success("Released")
		else toast.error("Release failed")
	}

	const submitComment = async () => {
		const body = commentDraft.trim()
		if (body.length === 0) return
		setBusy("comment")
		const result = await commentOnIssue({
			params: { issueId },
			payload: { body },
			reactivityKeys: invalidateKeys,
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			setCommentDraft("")
			toast.success("Comment added")
		} else {
			toast.error("Comment failed")
		}
	}

	const breadcrumbsLoading = [
		{ label: "Errors", href: "/errors" },
		{ label: "Issues", href: "/errors/issues" },
		{ label: "…" },
	] as const

	return Result.builder(detailResult)
		.onInitial(() => (
			<DashboardLayout breadcrumbs={[...breadcrumbsLoading]} title="Issue">
				<div className="space-y-4">
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-40 w-full" />
				</div>
			</DashboardLayout>
		))
		.onError((error) => (
			<DashboardLayout breadcrumbs={[...breadcrumbsLoading]} title="Issue">
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Failed to load issue</EmptyTitle>
						<EmptyDescription>
							{error.message ?? "Try refreshing or check API logs."}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</DashboardLayout>
		))
		.onSuccess((detail) => {
			const { issue, timeseries, sampleTraces, incidents, linkedAlertIncidents } = detail
			const totalInWindow = timeseries.reduce((sum, b) => sum + b.count, 0)
			const events = Result.isSuccess(eventsResult) ? eventsResult.value.events : []

			return (
				<DashboardLayout
					breadcrumbs={[
						{ label: "Errors", href: "/errors" },
						{ label: "Issues", href: "/errors/issues" },
						{ label: issue.exceptionType || "Unknown error" },
					]}
					title={issue.exceptionType || "Unknown error"}
					description={issue.serviceName}
					headerActions={
						<div className="flex items-center gap-2">
							<WorkflowBadge state={issue.workflowState} />
							{issue.hasOpenIncident ? (
								<Badge variant="outline" className="bg-destructive/10 text-destructive">
									Incident open
								</Badge>
							) : null}
						</div>
					}
					rightSidebar={
						<IssueSidebar
							issue={issue}
							totalInWindow={totalInWindow}
							busy={busy}
							onTransition={transitionTo}
							onClaim={claim}
							onHeartbeat={heartbeat}
							onRelease={release}
						/>
					}
				>
					<div className="space-y-8">
						<section className="space-y-4">
							<IssueHero issue={issue} />
							<IssueOccurrenceSparkline data={timeseries} />
						</section>

						<section aria-labelledby="activity-heading">
							<SectionHeader id="activity-heading" label="Activity" />
							<IssueTimeline events={events} />
							<IssueCommentComposer
								value={commentDraft}
								onChange={setCommentDraft}
								onSubmit={submitComment}
								disabled={busy === "comment"}
							/>
						</section>

						<section aria-labelledby="incidents-heading">
							<SectionHeader id="incidents-heading" label="Incidents" />
							<IssueIncidentsTable incidents={incidents} />
						</section>

						<section aria-labelledby="linked-alerts-heading">
							<SectionHeader id="linked-alerts-heading" label="Linked anomaly alerts" />
							<LinkedAlertIncidentsSection incidents={linkedAlertIncidents} />
						</section>

						<section aria-labelledby="occurrences-heading">
							<SectionHeader id="occurrences-heading" label="Latest occurrences" />
							<IssueOccurrencesTable traces={sampleTraces} />
						</section>
					</div>
				</DashboardLayout>
			)
		})
		.render()
}

function LinkedAlertIncidentsSection({
	incidents,
}: {
	incidents: ReadonlyArray<LinkedAlertIncidentDocument>
}) {
	if (incidents.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				No alert incidents are linked to this issue yet.
			</p>
		)
	}

	return (
		<div className="space-y-2">
			{incidents.map((incident) => (
				<Card key={incident.id}>
					<CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
						<div className="min-w-0 space-y-1">
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant="outline" className="capitalize">
									{incident.status}
								</Badge>
								<Badge variant="secondary">{incident.severity}</Badge>
								<span className="truncate text-sm font-medium">{incident.ruleName}</span>
							</div>
							<div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
								<span>{signalLabels[incident.signalType]}</span>
								{incident.groupKey && <span className="font-mono">{incident.groupKey}</span>}
								<span>{formatAlertDateTimeFull(incident.createdAt)}</span>
							</div>
						</div>
						<div className="flex shrink-0 flex-wrap items-center gap-2">
							{incident.anomalyScore != null && (
								<Badge variant="secondary" className="font-mono">
									score {incident.anomalyScore.toFixed(2)}
								</Badge>
							)}
							{incident.lastObservedValue != null && (
								<Badge variant="secondary" className="font-mono">
									{formatSignalValue(incident.signalType, incident.lastObservedValue)}
								</Badge>
							)}
							<Button
								variant="outline"
								size="sm"
								render={
									<Link
										to="/alerts/$ruleId"
										params={{ ruleId: incident.ruleId }}
										search={{ tab: "history" }}
									/>
								}
							>
								View alert
							</Button>
						</div>
					</CardContent>
				</Card>
			))}
		</div>
	)
}
