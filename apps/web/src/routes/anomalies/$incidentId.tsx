import { ChartError, ChartLoading } from "@maple/ui/components/charts/_shared/chart-state"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { useState } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { displayError } from "@/lib/error-messages"
import { Exit, Schema } from "effect"

import { PulseIcon } from "@/components/icons"
import { AnomalyHero } from "@/components/anomalies/anomaly-hero"
import { AnomalyLinkIssueDialog } from "@/components/anomalies/anomaly-link-issue-dialog"
import { AnomalyLinkedIssueCard } from "@/components/anomalies/anomaly-linked-issue-card"
import { AnomalySidebar } from "@/components/anomalies/anomaly-sidebar"
import { AnomalyTimeseriesChart } from "@/components/anomalies/anomaly-timeseries-chart"
import {
	isStaleOpenIncident,
	RESOLVE_REASON_LABEL,
	SEVERITY_TONE,
	SIGNAL_LABEL,
	severityToneFor,
} from "@/components/anomalies/anomaly-format"
import { useAnomalyMutations } from "@/components/anomalies/use-anomaly-mutations"
import { ResultPage } from "@/components/layout/result-page"
import { RelativeTime } from "@/components/common/relative-time"
import { toastExit } from "@/lib/error-toast"
import { SectionHeading } from "@/components/common/section-heading"
import { useIntervalRefresh } from "@/hooks/use-interval-refresh"
import { retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { anomalyIncidentFromV2, anomalyTimeseriesFromV2 } from "@/lib/services/anomalies"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ResourceNotFound } from "@/components/common/resource-not-found"
import { ResultView } from "@/components/common/result-view"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { AnomalyIncidentId, type AnomalyIncidentDocument, type ErrorIssueId } from "@maple/domain/http"

const decodeIncidentId = Schema.decodeSync(AnomalyIncidentId)

/**
 * The v2 envelope nests the failure under `error`, so the tag has to come from
 * `displayError` rather than a direct `_tag` read — the literal itself is
 * preserved end to end.
 */
const isIncidentNotFound = (error: unknown) =>
	displayError(error)._tag === "@maple/http/anomalies/AnomalyIncidentNotFoundError"
const LIVE_REFRESH_INTERVAL_MS = 15_000

export const Route = createFileRoute("/anomalies/$incidentId")({
	component: AnomalyDetailPage,
})

function AnomalyDetailPage() {
	const { incidentId: rawIncidentId } = Route.useParams()
	const incidentId = decodeIncidentId(rawIncidentId)

	const incidentQueryAtom = retainedQueryV2("anomalies", "getIncident", {
		params: { id: incidentId },
		reactivityKeys: ["anomalyIncidents", `anomalyIncident:${incidentId}`],
	})
	const incidentResult = useAtomValue(incidentQueryAtom)
	const refreshIncident = useAtomRefresh(incidentQueryAtom)

	const incident = Result.builder(incidentResult)
		.onSuccess(anomalyIncidentFromV2)
		.orElse(() => null)
	const isOpen = incident?.status === "open"

	// Live monitor: keep an open incident fresh while the page is visible.
	useIntervalRefresh(refreshIncident, {
		intervalMs: LIVE_REFRESH_INTERVAL_MS,
		enabled: isOpen,
	})

	const mutations = useAnomalyMutations()
	const [linkDialogOpen, setLinkDialogOpen] = useState(false)
	const [resolveConfirmOpen, setResolveConfirmOpen] = useState(false)
	const navigate = useNavigate()
	const createInvestigation = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "create"), {
		mode: "promiseExit",
	})

	const [resolve, resolving] = useAsyncAction(async () => {
		await mutations.resolveIncident(incidentId)
		setResolveConfirmOpen(false)
	})

	const [linkTo, linking] = useAsyncAction(async (issueId: ErrorIssueId) => {
		const result = await mutations.linkIssue(incidentId, issueId, incident?.errorIssueId ?? null)
		if (Exit.isSuccess(result)) setLinkDialogOpen(false)
	})

	const [unlink, unlinking] = useAsyncAction(async () => {
		await mutations.linkIssue(incidentId, null, incident?.errorIssueId ?? null)
	})

	const [investigate, investigating] = useAsyncAction(async (incident: AnomalyIncidentDocument) => {
		const result = await createInvestigation({
			payload: {
				subject: {
					type: "incident",
					incident_kind: "anomaly",
					incident_id: incidentId,
					...(incident.errorIssueId ? { issue_id: incident.errorIssueId } : undefined),
				} as never,
				snapshot: {
					title: `${SIGNAL_LABEL[incident.signalType]} · ${incident.serviceName}`,
					scope: incident.deploymentEnv || incident.serviceName,
					status: incident.status,
					severity: incident.severity === "critical" ? "critical" : "medium",
					facts: [
						{ label: "Signal", value: incident.signalType },
						{ label: "Service", value: incident.serviceName },
						{ label: "Last observed", value: String(incident.lastObservedValue) },
					],
					references: incident.errorIssueId
						? [{ label: "Issue", url: `/errors/issues/${incident.errorIssueId}` }]
						: [],
					incidentStartedAt: incident.firstTriggeredAt,
					incidentEndedAt: incident.resolvedAt,
				},
			},
			reactivityKeys: ["investigations"],
		})
		if (Exit.isSuccess(result)) {
			await navigate({ to: "/investigations/$id", params: { id: result.value.id } })
			return
		}
		toastExit(result, { error: "Failed to open investigation" })
	})

	const busy = resolving || linking || unlinking || investigating

	return (
		<ResultPage
			breadcrumbs={[{ label: "Anomalies", href: "/anomalies" }]}
			result={incidentResult}
			select={() => incident}
			crumb={(incident) =>
				[incident.serviceName, SIGNAL_LABEL[incident.signalType], incident.deploymentEnv]
					.filter(Boolean)
					.join(" · ")
			}
			isNotFoundError={isIncidentNotFound}
			errorTitle="Failed to load anomaly"
			onRetry={refreshIncident}
			loading={
				<div className="space-y-4">
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-64 w-full" />
					<Skeleton className="h-32 w-full" />
				</div>
			}
			notFound={
				<ResourceNotFound
					title="Anomaly not found"
					description="It may have been pruned, or the link is stale."
					backLink={<Link to="/anomalies" />}
					backLabel="Back to anomalies"
				/>
			}
			headerActions={(incident) => {
				const isStale = isStaleOpenIncident(incident)
				const tone = severityToneFor(incident)
				return (
					<div className="flex items-center gap-2">
						<Badge
							variant="outline"
							className={isStale ? SEVERITY_TONE.resolved.badge : tone.badge}
						>
							{isOpen && !isStale ? (
								<span className="flex items-center gap-1.5">
									<StatusDot tone={tone.tone} />
									{incident.severity}
								</span>
							) : isStale ? (
								<>
									Stale · last seen <RelativeTime value={incident.lastTriggeredAt} />
								</>
							) : incident.resolveReason !== null ? (
								RESOLVE_REASON_LABEL[incident.resolveReason]
							) : (
								"Resolved"
							)}
						</Badge>
						<Button
							size="sm"
							variant="outline"
							onClick={() => void investigate(incident)}
							disabled={busy}
							loading={investigating}
						>
							<PulseIcon className="size-3.5" />
							Open investigation
						</Button>
						{isOpen ? (
							<Button
								size="sm"
								variant="outline"
								onClick={() => setResolveConfirmOpen(true)}
								disabled={busy}
							>
								Resolve
							</Button>
						) : null}
					</div>
				)
			}}
			rightPanel={(incident) => (
				<AnomalySidebar
					incident={incident}
					busy={busy}
					onResolve={() => setResolveConfirmOpen(true)}
					onOpenLinkDialog={() => setLinkDialogOpen(true)}
					onUnlink={unlink}
				/>
			)}
		>
			{(incident) => (
				<>
					<div className="space-y-8">
						<section className="space-y-4">
							<AnomalyHero incident={incident} />
							<AnomalySignalChart incident={incident} incidentId={incidentId} />
						</section>

						<section aria-labelledby="linked-issue-heading">
							<SectionHeading
								variant="eyebrow"
								id="linked-issue-heading"
								title="Linked issue"
							/>
							<AnomalyLinkedIssueCard
								incident={incident}
								onOpenLinkDialog={() => setLinkDialogOpen(true)}
								onUnlink={unlink}
								busy={busy}
							/>
						</section>
					</div>

					<AnomalyLinkIssueDialog
						incident={incident}
						open={linkDialogOpen}
						onOpenChange={setLinkDialogOpen}
						onSelect={linkTo}
					/>

					<ConfirmDialog
						open={resolveConfirmOpen}
						onOpenChange={setResolveConfirmOpen}
						tone="default"
						icon={null}
						title="Resolve this anomaly?"
						description={
							<>
								The incident is marked resolved manually
								{incident.fingerprints.filter((f) => f.resolvedAt === null).length > 1
									? ", including every error fingerprint grouped into it"
									: ""}
								. If the signal keeps deviating, the detector waits out a one-hour cooldown
								before re-opening it.
							</>
						}
						confirmLabel="Resolve"
						pending={busy}
						onConfirm={resolve}
					/>
				</>
			)}
		</ResultPage>
	)
}

/** The incident's signal series, fetched once the incident itself has loaded. */
function AnomalySignalChart({
	incident,
	incidentId,
}: {
	incident: AnomalyIncidentDocument
	incidentId: AnomalyIncidentId
}) {
	const timeseriesQueryAtom = retainedQueryV2("anomalies", "getIncidentTimeseries", {
		params: { id: incidentId },
		query: {},
		reactivityKeys: [`anomalyIncident:${incidentId}:timeseries`],
	})
	const timeseriesResult = useAtomValue(timeseriesQueryAtom)
	const refreshTimeseries = useAtomRefresh(timeseriesQueryAtom)

	useIntervalRefresh(refreshTimeseries, {
		intervalMs: LIVE_REFRESH_INTERVAL_MS,
		enabled: incident.status === "open",
	})

	return (
		<ResultView
			result={timeseriesResult}
			loading={<ChartLoading variant="line" height={256} />}
			error={() => <ChartError height={256}>Failed to load signal data.</ChartError>}
		>
			{(timeseries) => (
				<AnomalyTimeseriesChart
					incident={incident}
					timeseries={anomalyTimeseriesFromV2(timeseries)}
				/>
			)}
		</ResultView>
	)
}
