import { useMemo } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Exit, Schema } from "effect"
import { formatWarehouseDateTime } from "@maple/query-engine"
import {
	AlertRulePreviewResponse,
	type AlertDestinationType,
	type AlertIncidentDocument,
	type AlertRuleDocument,
} from "@maple/domain/http"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { decodeAlertContextFromSearchParam } from "@/components/chat/alert-context"
import { PROVIDERS } from "@/components/alerts/destination-provider"
import { IncidentBody, IncidentHeader } from "@/components/alerts/incident-detail/incident-detail-view"
import { DetailHeaderSkeleton } from "@/components/common/detail-header"
import { ResourceNotFound } from "@/components/common/resource-not-found"
import { DashboardPage } from "@/components/layout/dashboard-page"
import { useAlertRulePreview } from "@/hooks/use-alert-rule-preview"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { useAlertRuleStates } from "@/hooks/use-alert-rule-states"
import { useAlertIncidentsList, useAlertRulesList } from "@/hooks/use-alerts-list"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import {
	formatSignalValue,
	ruleToFormState,
	signalLabels,
	v2DeliveryToDocument,
} from "@/lib/alerts/form-utils"
import {
	buildIncidentTimeline,
	incidentGroup,
} from "@/lib/alerts/incident-timeline"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { toastExit } from "@/lib/error-toast"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"

const SearchSchema = Schema.Struct({
	/** Base64url alert context carried by notification links; only used to point back at the rule. */
	alert: Schema.optional(Schema.String),
})

export const Route = createFileRoute("/alerts/incidents/$incidentId")({
	component: AlertIncidentPage,
	validateSearch: Schema.toStandardSchemaV1(SearchSchema),
})

const MINUTE_MS = 60_000
const destinationTypeLabel = (type: AlertDestinationType) => PROVIDERS[type].label

function AlertIncidentPage() {
	const { incidentId } = Route.useParams()
	const { alert: alertParam } = Route.useSearch()
	const { result: incidentsResult } = useAlertIncidentsList()
	const { result: rulesResult } = useAlertRulesList()

	const incidents = Result.builder(incidentsResult)
		.onSuccess((r) => r.incidents)
		.orElse(() => [])
	const rules = Result.builder(rulesResult)
		.onSuccess((r) => r.rules)
		.orElse(() => [])
	const incident = incidents.find((i) => i.id === incidentId) ?? null

	if (incident == null && Result.isInitial(incidentsResult)) {
		return (
			<DashboardPage
				breadcrumbs={[{ label: "Alerts", href: "/alerts" }, { label: "Loading" }]}
				header={<DetailHeaderSkeleton />}
			>
				<Skeleton className="h-[300px] w-full" />
				<Skeleton className="h-40 w-full" />
			</DashboardPage>
		)
	}

	if (incident == null) {
		const ruleId = alertParam ? decodeAlertContextFromSearchParam(alertParam)?.ruleId : undefined
		return (
			<DashboardPage breadcrumbs={[{ label: "Alerts", href: "/alerts" }, { label: "Not found" }]}>
				<ResourceNotFound
					title="Incident not found"
					description="It may have been pruned, or the link is stale."
					backLink={
						ruleId ? <Link to="/alerts/$ruleId" params={{ ruleId }} /> : <Link to="/alerts" />
					}
					backLabel={ruleId ? "Open the rule" : "Back to alerts"}
				/>
			</DashboardPage>
		)
	}

	return (
		<IncidentDetail
			incident={incident}
			rule={rules.find((r) => r.id === incident.ruleId) ?? null}
			ruleIncidents={incidents.filter((i) => i.ruleId === incident.ruleId)}
		/>
	)
}

/** The minute this incident row was last seen; the argument only keys the memo. */
const clockAtSync = (_incident: AlertIncidentDocument) => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS

function IncidentDetail({
	incident,
	rule,
	ruleIncidents,
}: {
	incident: AlertIncidentDocument
	rule: AlertRuleDocument | null
	ruleIncidents: ReadonlyArray<AlertIncidentDocument>
}) {
	const navigate = useNavigate()
	const { effectiveTimezone: timeZone } = useTimezonePreference()

	// Wall clock to the minute, refreshed only when the incident row changes, so the
	// preview query key holds steady between syncs.
	const now = useMemo(() => clockAtSync(incident), [incident])

	const range = useMemo(() => {
		const start = Date.parse(incident.firstTriggeredAt)
		const pad = Math.max(30, (rule?.windowMinutes ?? 5) * 4) * MINUTE_MS
		const end = incident.resolvedAt != null ? Math.min(Date.parse(incident.resolvedAt) + pad, now) : now
		return { start: start - pad, end: Math.max(end, start + MINUTE_MS) }
	}, [incident.firstTriggeredAt, incident.resolvedAt, rule?.windowMinutes, now])

	const formState = useMemo(() => (rule ? ruleToFormState(rule) : null), [rule])
	const { preview, previewLoading, previewError } = useAlertRulePreview(formState, {
		startTime: formatWarehouseDateTime(range.start),
		endTime: formatWarehouseDateTime(range.end),
	})
	// A grouped rule previews every group; the incident is about one of them.
	const groupPreview = useMemo(() => {
		if (preview == null || incident.groupKey == null) return preview
		const series = preview.series.filter((s) => s.groupKey === incident.groupKey)
		if (series.length === 0 || series.length === preview.series.length) return preview
		return new AlertRulePreviewResponse({ ...preview, series, wouldFire: [] })
	}, [preview, incident.groupKey])

	const deliveriesResult = useAtomValue(
		retainedQueryV2("alertDeliveries", "list", {
			query: { incident_id: incident.id, limit: 100 },
			reactivityKeys: ["alertDeliveryEvents"],
		}),
	)
	const investigationsResult = useAtomValue(
		retainedQueryV2("investigations", "list", {
			query: { incident_kind: "alert", incident_id: incident.id, limit: 1 },
			reactivityKeys: ["investigations"],
		}),
	)
	const investigation = Result.builder(investigationsResult)
		.onSuccess((page) => page.data[0] ?? null)
		.orElse(() => null)
	const states = useAlertRuleStates(incident.ruleId)

	const entries = useMemo(
		() =>
			buildIncidentTimeline({
				incident,
				deliveries: Result.builder(deliveriesResult)
					.onSuccess((page) => page.data.map(v2DeliveryToDocument))
					.orElse(() => []),
				investigation,
				renotifyIntervalMinutes:
					rule != null && rule.destinationIds.length > 0 ? rule.renotifyIntervalMinutes : null,
				destinationTypeLabel,
			}),
		[incident, deliveriesResult, investigation, rule],
	)

	const createInvestigation = useAtomSet(MapleApiV2AtomClient.mutation("investigations", "create"), {
		mode: "promiseExit",
	})
	// Pending while the create request runs, so repeat clicks cannot start duplicates.
	const [startInvestigation, startingInvestigation] = useAsyncAction(async () => {
		const result = await createInvestigation({
			payload: {
				subject:
					incident.errorIssueId != null
						? {
								type: "incident",
								incident_kind: "alert",
								incident_id: incident.id,
								issue_id: incident.errorIssueId,
							}
						: { type: "incident", incident_kind: "alert", incident_id: incident.id },
				snapshot: {
					title: incident.ruleName,
					scope: incidentGroup(incident) ?? "all",
					status: incident.status,
					severity: incident.severity === "critical" ? "critical" : "medium",
					facts: [
						{ label: "Signal", value: signalLabels[incident.signalType] },
						{
							label: "Observed",
							value: formatSignalValue(incident.signalType, incident.lastObservedValue),
						},
						{
							label: "Threshold",
							value: formatSignalValue(incident.signalType, incident.threshold),
						},
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
		toastExit(result, { error: "Failed to start investigation" })
	})

	return (
		<DashboardPage
			breadcrumbs={[
				{ label: "Alerts", href: "/alerts" },
				{ label: rule?.name ?? incident.ruleName, href: `/alerts/${incident.ruleId}` },
				{ label: "Incident" },
			]}
			header={
				<IncidentHeader
					incident={incident}
					rule={rule}
					now={now}
					timeZone={timeZone}
					investigationId={investigation?.id ?? null}
					investigationPending={startingInvestigation || Result.isInitial(investigationsResult)}
					onInvestigate={() => void startInvestigation()}
				/>
			}
		>
			<IncidentBody
				incident={incident}
				rule={rule}
				ruleIncidents={ruleIncidents}
				states={states}
				preview={groupPreview}
				previewLoading={previewLoading}
				previewError={previewError}
				range={range}
				now={now}
				timeZone={timeZone}
				entries={entries}
				entriesLoading={Result.isInitial(deliveriesResult)}
				entriesFailed={Result.isFailure(deliveriesResult)}
			/>
		</DashboardPage>
	)
}
