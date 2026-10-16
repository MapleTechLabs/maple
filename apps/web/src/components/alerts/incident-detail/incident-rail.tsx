import { Link } from "@tanstack/react-router"
import { formatWarehouseDateTime } from "@maple/query-engine"
import type { AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { cn } from "@maple/ui/lib/utils"

import type { AlertRuleStateRow } from "@/lib/collections/alerts"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import { conditionPhrase, incidentGroup, signalTitle } from "@/lib/alerts/incident-timeline"

const GROUP_ROW_LIMIT = 8
const DAY_MS = 24 * 60 * 60 * 1000

function RailSection({
	title,
	action,
	children,
}: {
	title: React.ReactNode
	action?: React.ReactNode
	children: React.ReactNode
}) {
	return (
		<section className="space-y-3 border-b pb-5 last:border-b-0">
			<div className="flex items-center justify-between gap-2">
				<Eyebrow as="h2">{title}</Eyebrow>
				{action}
			</div>
			{children}
		</section>
	)
}

function GroupsSection({
	rule,
	incident,
	states,
	openIncidents,
}: {
	rule: AlertRuleDocument
	incident: AlertIncidentDocument
	states: ReadonlyArray<AlertRuleStateRow>
	openIncidents: ReadonlyArray<AlertIncidentDocument>
}) {
	const rows = states.toSorted((a, b) => {
		const breached = Number(b.last_status === "breached") - Number(a.last_status === "breached")
		return breached !== 0 ? breached : (b.last_value ?? 0) - (a.last_value ?? 0)
	})
	const breaching = rows.filter((row) => row.last_status === "breached").length
	const openByGroup = new Map(openIncidents.map((open) => [open.groupKey, open]))
	return (
		<RailSection title={`Groups · ${breaching} of ${rows.length} breaching`}>
			<ul className="space-y-2">
				{rows.slice(0, GROUP_ROW_LIMIT).map((row) => {
					const breached = row.last_status === "breached"
					const open = openByGroup.get(row.group_key)
					const current = row.group_key === incident.groupKey
					return (
						<li key={row.group_key} className="flex items-center gap-2 text-sm">
							<StatusDot
								tone={breached ? "crit" : row.last_status == null ? "neutral" : "ok"}
							/>
							{open != null && !current ? (
								<Link
									to="/alerts/incidents/$incidentId"
									params={{ incidentId: open.id }}
									className="min-w-0 flex-1 truncate hover:underline"
								>
									{row.group_key}
								</Link>
							) : (
								<span className={cn("min-w-0 flex-1 truncate", current && "font-medium")}>
									{row.group_key}
								</span>
							)}
							<span
								className={cn(
									"font-mono text-xs tabular-nums",
									breached ? "text-severity-error" : "text-muted-foreground",
								)}
							>
								{formatSignalValue(rule.signalType, row.last_value)}
							</span>
						</li>
					)
				})}
			</ul>
			{rows.length > GROUP_ROW_LIMIT ? (
				<p className="text-muted-foreground text-xs">{rows.length - GROUP_ROW_LIMIT} more groups</p>
			) : null}
		</RailSection>
	)
}

function EvidenceLink({ detail, children }: { detail: string; children: React.ReactElement }) {
	return (
		<li className="space-y-0.5">
			{children}
			<p className="text-muted-foreground text-xs">{detail}</p>
		</li>
	)
}

/** Services the incident is about: its group for a per-service rule, else the rule's scope. */
function incidentServices(
	rule: AlertRuleDocument | null,
	incident: AlertIncidentDocument,
): ReadonlyArray<string> {
	const group = incidentGroup(incident)
	if (group != null && rule?.groupBy?.length === 1 && rule.groupBy[0] === "service.name") return [group]
	return rule?.serviceNames ?? []
}

function EvidenceSection({
	rule,
	incident,
	window,
}: {
	rule: AlertRuleDocument | null
	incident: AlertIncidentDocument
	window: { start: number; end: number }
}) {
	const services = incidentServices(rule, incident)
	const range = {
		startTime: formatWarehouseDateTime(window.start),
		endTime: formatWarehouseDateTime(window.end),
	}
	const scope = services.length > 0 ? services.join(", ") : "all services"
	const servicesSearch = services.length > 0 ? [...services] : undefined
	return (
		<RailSection title="Evidence">
			<ul className="space-y-3 text-sm">
				{incident.errorIssueId != null ? (
					<EvidenceLink detail="The error issue behind this alert">
						<Link
							to="/errors/issues/$issueId"
							params={{ issueId: incident.errorIssueId }}
							className="hover:underline"
						>
							Linked error issue
						</Link>
					</EvidenceLink>
				) : null}
				<EvidenceLink detail={`${scope}, incident window`}>
					<Link
						to="/traces"
						search={{
							services: servicesSearch,
							hasError: incident.signalType === "error_rate" ? true : undefined,
							...range,
						}}
						className="hover:underline"
					>
						{incident.signalType === "error_rate" ? "Error traces" : "Traces"}
					</Link>
				</EvidenceLink>
				<EvidenceLink detail={`${scope}, incident window`}>
					<Link
						to="/logs"
						search={{ services: servicesSearch, ...range }}
						className="hover:underline"
					>
						Logs
					</Link>
				</EvidenceLink>
			</ul>
		</RailSection>
	)
}

function RuleSection({
	rule,
	ruleIncidents,
	now,
}: {
	rule: AlertRuleDocument
	ruleIncidents: ReadonlyArray<AlertIncidentDocument>
	now: number
}) {
	const recent = ruleIncidents.filter((i) => now - Date.parse(i.firstTriggeredAt) <= 30 * DAY_MS)
	const durations = recent
		.flatMap((i) =>
			i.resolvedAt != null ? [Date.parse(i.resolvedAt) - Date.parse(i.firstTriggeredAt)] : [],
		)
		.toSorted((a, b) => a - b)
	const median = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : undefined
	const scope = [
		rule.groupBy != null && rule.groupBy.length > 0 ? `split by ${rule.groupBy.join(", ")}` : null,
		rule.environments.length > 0 ? rule.environments.join(", ") : null,
	].filter((part) => part != null)
	const breaches = rule.consecutiveBreachesRequired
	const summary = `${signalTitle(rule.signalType)} ${conditionPhrase(rule)} over ${rule.windowMinutes}m, ${breaches} ${breaches === 1 ? "check" : "checks in a row"} to open${scope.length > 0 ? `, ${scope.join(", ")}` : ""}.`
	return (
		<RailSection
			title="Rule"
			action={
				<Link
					to="/alerts/create"
					search={{ ruleId: rule.id }}
					className="text-primary text-xs hover:underline"
				>
					Edit rule
				</Link>
			}
		>
			<div className="space-y-2">
				<Link
					to="/alerts/$ruleId"
					params={{ ruleId: rule.id }}
					className="block text-sm hover:underline"
				>
					{rule.name}
				</Link>
				<p className="text-muted-foreground text-xs leading-relaxed">{summary}</p>
				<p className="text-muted-foreground text-xs">
					Fired {recent.length} {recent.length === 1 ? "time" : "times"} in 30d
					{median != null ? ` · median ${Math.max(1, Math.round(median / 60_000))}m` : ""}
				</p>
			</div>
		</RailSection>
	)
}

export function IncidentRail({
	rule,
	incident,
	states,
	ruleIncidents,
	window,
	now,
}: {
	rule: AlertRuleDocument | null
	incident: AlertIncidentDocument
	states: ReadonlyArray<AlertRuleStateRow>
	ruleIncidents: ReadonlyArray<AlertIncidentDocument>
	window: { start: number; end: number }
	now: number
}) {
	const grouped = rule != null && rule.groupBy != null && rule.groupBy.length > 0 && states.length > 1
	return (
		<aside className="space-y-5 lg:border-l lg:pl-6">
			{grouped ? (
				<GroupsSection
					rule={rule}
					incident={incident}
					states={states}
					openIncidents={ruleIncidents.filter((i) => i.status === "open")}
				/>
			) : null}
			<EvidenceSection rule={rule} incident={incident} window={window} />
			{rule != null ? <RuleSection rule={rule} ruleIncidents={ruleIncidents} now={now} /> : null}
		</aside>
	)
}
