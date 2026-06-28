import { useMemo } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { ChatConversation } from "@/components/chat/chat-conversation"
import { FlueClientProvider } from "@/components/chat/flue-client-provider"
import {
	alertTabId,
	decodeAlertContextFromSearchParam,
	signalLabel,
	toAlertContext,
	type AlertContext,
} from "@/components/chat/alert-context"
import { formatAlertComparator } from "@/components/chat/context-preamble"
import { IncidentDiagnosisReport } from "@/components/ai-triage/incident-diagnosis-report"
import { IncidentReportSidebar } from "@/components/ai-triage/incident-report-sidebar"
import { useAiTriageRun } from "@/components/ai-triage/use-ai-triage-run"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { ChatBubbleSparkleIcon } from "@/components/icons"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { comparatorLabels, formatSignalValue, signalLabels } from "@/lib/alerts/form-utils"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { useMediaQuery } from "@maple/ui/hooks/use-media-query"
import { cn } from "@maple/ui/lib/utils"
import type { AlertSeverity, ErrorIssueId } from "@maple/domain/http"

const SearchSchema = Schema.Struct({
	/** Base64url alert context carried by the "Ask Maple AI" notification link. */
	alert: Schema.optional(Schema.String),
})

export const Route = effectRoute(createFileRoute("/alerts/incidents/$incidentId"))({
	component: AlertIncidentPage,
	validateSearch: Schema.toStandardSchemaV1(SearchSchema),
})

function AlertIncidentPage() {
	const { incidentId } = Route.useParams()
	const { alert: alertParam } = Route.useSearch()

	// The notification link carries the alert context inline, so the page can
	// render the header + seed the chat instantly without waiting on a fetch.
	const paramContext = useMemo(
		() => (alertParam ? decodeAlertContextFromSearchParam(alertParam) : undefined),
		[alertParam],
	)

	const incidentsResult = useAtomValue(
		MapleApiAtomClient.query("alerts", "listIncidents", { reactivityKeys: ["alertIncidents"] }),
	)
	const rulesResult = useAtomValue(
		MapleApiAtomClient.query("alerts", "listRules", { reactivityKeys: ["alertRules"] }),
	)

	const incidents = Result.builder(incidentsResult)
		.onSuccess((r) => r.incidents)
		.orElse(() => [])
	const rules = Result.builder(rulesResult)
		.onSuccess((r) => r.rules)
		.orElse(() => [])

	const incident = incidents.find((i) => i.id === incidentId) ?? null
	const rule = incident
		? (rules.find((r) => r.id === incident.ruleId) ?? null)
		: paramContext
			? (rules.find((r) => r.id === paramContext.ruleId) ?? null)
			: null

	const loading = Result.isInitial(incidentsResult) || Result.isInitial(rulesResult)

	// Prefer the authoritative fetched rows; fall back to the link's inline context
	// (e.g. a stale link to a since-pruned incident still opens the report).
	const alertContext: AlertContext | null =
		incident && rule ? toAlertContext(rule, incident) : (paramContext ?? null)
	const issueId: ErrorIssueId | undefined = incident?.errorIssueId ?? undefined

	if (loading && !alertContext) {
		return (
			<DashboardLayout
				breadcrumbs={[{ label: "Alerts", href: "/alerts" }, { label: "…" }]}
				title="Ask Maple AI"
			>
				<div className="mx-auto w-full max-w-3xl space-y-4">
					<Skeleton className="h-4 w-32" />
					<Skeleton className="h-8 w-3/4" />
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-2/3" />
				</div>
			</DashboardLayout>
		)
	}

	if (!alertContext) {
		return (
			<DashboardLayout
				breadcrumbs={[{ label: "Alerts", href: "/alerts" }, { label: "Not found" }]}
				title="Ask Maple AI"
			>
				<Empty>
					<EmptyHeader>
						<EmptyTitle>Incident not found</EmptyTitle>
						<EmptyDescription>It may have been resolved and pruned, or the link is stale.</EmptyDescription>
					</EmptyHeader>
					<Button variant="outline" size="sm" render={<Link to="/alerts" />}>
						Back to alerts
					</Button>
				</Empty>
			</DashboardLayout>
		)
	}

	// Format from the typed rule/incident when fetched; fall back to the link's
	// raw strings only for a stale param-only link.
	const severity: AlertSeverity | null = incident?.severity ?? rule?.severity ?? null
	const isFiring = incident ? incident.status === "open" : alertContext.eventType !== "resolve"
	const condition = rule
		? `${signalLabels[rule.signalType]} ${comparatorLabels[rule.comparator]} ${formatSignalValue(rule.signalType, incident?.threshold ?? rule.threshold)} over ${rule.windowMinutes}min`
		: `${signalLabel(alertContext.signalType)} ${formatAlertComparator(alertContext.comparator)} ${alertContext.threshold} over ${alertContext.windowMinutes}min`

	return (
		<IncidentReportView
			incidentId={incidentId}
			issueId={issueId}
			alertContext={alertContext}
			severity={severity}
			isFiring={isFiring}
			condition={condition}
		/>
	)
}

function IncidentReportView({
	incidentId,
	issueId,
	alertContext,
	severity,
	isFiring,
	condition,
}: {
	incidentId: string
	issueId: ErrorIssueId | undefined
	alertContext: AlertContext
	severity: AlertSeverity | null
	isFiring: boolean
	condition: string
}) {
	const triage = useAiTriageRun({ incidentKind: "alert", incidentId, issueId })
	const isWide = useMediaQuery("lg")

	// Arriving here IS the intent to diagnose: once the runs query resolves to
	// none, mounting the trigger fires a run (mount-effect escape hatch — no raw effect).
	const showAutoRun = !triage.runsLoading && !triage.runsFailed && triage.run === null

	const breadcrumbs = [
		{ label: "Alerts", href: "/alerts" as const },
		{ label: alertContext.ruleName, href: `/alerts/${alertContext.ruleId}` },
		{ label: "Ask Maple AI" },
	]

	// One chat instance, placed in the right rail on wide screens and stacked
	// below the report otherwise — gated on a single breakpoint so it never
	// double-mounts (which would open two Flue sessions on the same tab).
	const chat = (
		<div
			className={cn(
				"flex flex-col overflow-hidden bg-card/30",
				isWide ? "h-full w-96 border-l" : "mt-8 h-[70vh] min-h-[460px] rounded-xl border",
			)}
		>
			<div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
				<ChatBubbleSparkleIcon className="size-4 text-muted-foreground" />
				<span className="text-sm font-medium">Ask Maple AI</span>
			</div>
			<FlueClientProvider>
				<ChatConversation
					tabId={alertTabId(alertContext)}
					isActive
					mode="alert"
					alertContext={alertContext}
				/>
			</FlueClientProvider>
		</div>
	)

	return (
		<DashboardLayout
			breadcrumbs={breadcrumbs}
			title={alertContext.ruleName}
			description={condition}
			headerActions={
				<div className="flex items-center gap-2">
					{severity ? <AlertSeverityBadge severity={severity} /> : null}
					<AlertStatusBadge state={isFiring ? "firing" : "resolved"} />
				</div>
			}
			filterSidebar={
				<IncidentReportSidebar
					alertContext={alertContext}
					result={triage.result}
					run={triage.run}
					onRerun={triage.startRun}
					rerunning={triage.isStarting}
				/>
			}
			rightSidebar={isWide ? chat : undefined}
		>
			{showAutoRun ? <AutoRunTrigger onFire={triage.startRun} /> : null}
			<IncidentDiagnosisReport triage={triage} />
			{!isWide ? chat : null}
		</DashboardLayout>
	)
}

/** Zero-DOM trigger: firing once on mount is how "resolved to no runs" kicks off a diagnosis. */
function AutoRunTrigger({ onFire }: { onFire: () => void }) {
	useMountEffect(() => {
		onFire()
	})
	return null
}
