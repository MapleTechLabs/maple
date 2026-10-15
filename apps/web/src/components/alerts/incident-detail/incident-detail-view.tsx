import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import type {
	AlertIncidentDocument,
	AlertRulePreviewResponse,
	AlertRuleDocument,
	InvestigationId,
} from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"

import { AlertRuleChart } from "@/components/alerts/alert-rule-chart"
import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { IncidentRail } from "@/components/alerts/incident-detail/incident-rail"
import { IncidentTimeline } from "@/components/alerts/incident-detail/incident-timeline"
import { ChatBubbleSparkleIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { formatAlertDuration, formatSignalValue, signalLabels } from "@/lib/alerts/form-utils"
import {
	conditionPhrase,
	holdReasonLabel,
	incidentGroup,
	type IncidentTimelineEntry,
	signalTitle,
} from "@/lib/alerts/incident-timeline"
import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import { formatDateInTimezone, formatTimeInTimezone } from "@/lib/timezone-format"

function statusLine(incident: AlertIncidentDocument, now: number, timeZone: string): string {
	const at = (iso: string) =>
		formatDateInTimezone(iso, { timeZone }) === formatDateInTimezone(now, { timeZone })
			? formatTimeInTimezone(iso, { timeZone })
			: `${formatDateInTimezone(iso, { timeZone })} ${formatTimeInTimezone(iso, { timeZone })}`
	if (incident.status === "resolved") {
		return `Resolved ${incident.resolvedAt ? at(incident.resolvedAt) : ""} · lasted ${formatAlertDuration(incident.firstTriggeredAt, incident.resolvedAt)}`
	}
	if (incident.holdReason != null) {
		return `Waiting on data · ${holdReasonLabel[incident.holdReason]}`
	}
	return `Open ${formatAlertDuration(incident.firstTriggeredAt, new Date(now).toISOString())} · since ${at(incident.firstTriggeredAt)}`
}

/** The incident page header: severity, status line, title, condition and the investigation action. */
export function IncidentHeader({
	incident,
	rule,
	now,
	timeZone,
	investigationId,
	investigationPending,
	onInvestigate,
}: {
	incident: AlertIncidentDocument
	rule: AlertRuleDocument | null
	now: number
	timeZone: string
	investigationId: InvestigationId | null
	investigationPending: boolean
	onInvestigate: () => void
}) {
	const group = incidentGroup(incident)
	const title = `${signalTitle(incident.signalType)} ${formatSignalValue(incident.signalType, incident.lastObservedValue)}${group != null ? ` on ${group}` : ""}`
	const subline = [
		`Rule ${rule?.name ?? incident.ruleName}`,
		`${incident.signalType === "builder_query" || incident.signalType === "raw_query" ? "value" : signalLabels[incident.signalType].toLowerCase()} ${conditionPhrase(incident)}${rule != null ? ` over ${rule.windowMinutes}m` : ""}`,
		rule != null && rule.environments.length > 0 ? rule.environments.join(", ") : null,
	]
		.filter((part) => part != null)
		.join(" · ")

	return (
		<DashboardLayout.Header
			titleContent={
				<div className="min-w-0 space-y-2">
					<div className="flex flex-wrap items-center gap-2.5">
						<AlertSeverityBadge severity={incident.severity} />
						<span className="text-muted-foreground text-xs">
							{statusLine(incident, now, timeZone)}
						</span>
					</div>
					<DashboardLayout.Title title={title}>{title}</DashboardLayout.Title>
					<p className="truncate text-muted-foreground text-xs">{subline}</p>
				</div>
			}
		>
			{investigationId != null ? (
				<Button
					variant="outline"
					size="sm"
					render={<Link to="/investigations/$id" params={{ id: investigationId }} />}
				>
					<ChatBubbleSparkleIcon />
					Open investigation
				</Button>
			) : (
				<Button variant="outline" size="sm" disabled={investigationPending} onClick={onInvestigate}>
					<ChatBubbleSparkleIcon />
					Investigate
				</Button>
			)}
		</DashboardLayout.Header>
	)
}

/** The incident page body: signal chart, timeline and rail, all from props. */
export function IncidentBody({
	incident,
	rule,
	ruleIncidents,
	states,
	preview,
	previewLoading,
	previewError,
	range,
	now,
	timeZone,
	entries,
	entriesLoading,
	entriesFailed,
}: {
	incident: AlertIncidentDocument
	rule: AlertRuleDocument | null
	ruleIncidents: ReadonlyArray<AlertIncidentDocument>
	states: ReadonlyArray<AlertRuleStateRow>
	preview: AlertRulePreviewResponse | null
	previewLoading: boolean
	previewError: string | null
	range: { start: number; end: number }
	now: number
	timeZone: string
	entries: ReadonlyArray<IncidentTimelineEntry>
	entriesLoading: boolean
	entriesFailed: boolean
}) {
	const group = incidentGroup(incident)
	// The chart is memoized; keep its array and window props referentially stable.
	const chartIncidents = useMemo(() => [incident], [incident])
	const chartWindow = useMemo(() => ({ min: range.start, max: range.end }), [range.start, range.end])
	return (
		<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
			<div className="min-w-0 space-y-8">
				<section className="space-y-3">
					<Eyebrow as="h2">
						{signalTitle(incident.signalType)}
						{group != null ? ` · ${group}` : ""}
					</Eyebrow>
					{rule != null ? (
						<AlertRuleChart
							preview={preview}
							incidents={chartIncidents}
							threshold={incident.threshold}
							thresholdUpper={incident.thresholdUpper}
							comparator={incident.comparator}
							signalType={incident.signalType}
							window={chartWindow}
							source="preview"
							loading={previewLoading}
							error={previewError}
						/>
					) : (
						<p className="text-muted-foreground text-sm">
							The rule behind this incident was deleted, so its signal cannot be replayed.
						</p>
					)}
				</section>
				<IncidentTimeline
					entries={entries}
					timeZone={timeZone}
					loading={entriesLoading}
					failed={entriesFailed}
				/>
			</div>
			<IncidentRail
				rule={rule}
				incident={incident}
				states={states}
				ruleIncidents={ruleIncidents}
				window={range}
				now={now}
			/>
		</div>
	)
}
