import { useMemo } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { effectRoute } from "@effect-router/core"
import { Schema } from "effect"

import { AiTriageCard } from "@/components/ai-triage/ai-triage-card"
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
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { comparatorLabels, formatSignalValue, signalLabels } from "@/lib/alerts/form-utils"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { Button } from "@maple/ui/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@maple/ui/components/ui/empty"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import type { ErrorIssueId } from "@maple/domain/http"

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
	// (e.g. a stale link to a since-pruned incident still opens the chat).
	const alertContext: AlertContext | null =
		incident && rule ? toAlertContext(rule, incident) : (paramContext ?? null)
	const issueId: ErrorIssueId | undefined = incident?.errorIssueId ?? undefined

	const breadcrumbs = [
		{ label: "Alerts", href: "/alerts" as const },
		...(alertContext
			? [{ label: alertContext.ruleName, href: `/alerts/${alertContext.ruleId}` }]
			: []),
		{ label: "Ask Maple AI" },
	]

	if (loading && !alertContext) {
		return (
			<DashboardLayout breadcrumbs={[{ label: "Alerts", href: "/alerts" }, { label: "…" }]} title="Ask Maple AI">
				<div className="space-y-4">
					<Skeleton className="h-16 w-full" />
					<div className="grid gap-4 lg:grid-cols-2">
						<Skeleton className="h-72 w-full" />
						<Skeleton className="h-72 w-full" />
					</div>
				</div>
			</DashboardLayout>
		)
	}

	if (!alertContext) {
		return (
			<DashboardLayout breadcrumbs={[{ label: "Alerts", href: "/alerts" }, { label: "Not found" }]} title="Ask Maple AI">
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
	const severity = incident?.severity ?? rule?.severity ?? null
	const isFiring = incident ? incident.status === "open" : alertContext.eventType !== "resolve"
	const condition = rule
		? `${signalLabels[rule.signalType]} ${comparatorLabels[rule.comparator]} ${formatSignalValue(rule.signalType, incident?.threshold ?? rule.threshold)} over ${rule.windowMinutes}min`
		: `${signalLabel(alertContext.signalType)} ${alertContext.comparator} ${alertContext.threshold} over ${alertContext.windowMinutes}min`

	return (
		<DashboardLayout breadcrumbs={breadcrumbs} title={alertContext.ruleName}>
			<div className="space-y-4">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<h1 className="text-xl font-semibold tracking-tight">{alertContext.ruleName}</h1>
					{severity ? <AlertSeverityBadge severity={severity} /> : null}
					<AlertStatusBadge state={isFiring ? "firing" : "resolved"} />
					<span className="text-sm text-muted-foreground">{condition}</span>
					{alertContext.groupKey ? (
						<span className="font-mono text-xs text-muted-foreground">· {alertContext.groupKey}</span>
					) : null}
				</div>

				<div className="grid gap-4 lg:grid-cols-2 lg:items-start">
					<AiTriageCard
						incidentKind="alert"
						incidentId={incidentId}
						issueId={issueId}
						autoRun
					/>
					<div className="flex h-[72vh] min-h-[460px] flex-col overflow-hidden rounded-xl border border-border bg-card">
						<FlueClientProvider>
							<ChatConversation
								tabId={alertTabId(alertContext)}
								isActive
								mode="alert"
								alertContext={alertContext}
							/>
						</FlueClientProvider>
					</div>
				</div>
			</div>
		</DashboardLayout>
	)
}
