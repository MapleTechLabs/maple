import { Link } from "@tanstack/react-router"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { RelativeTime } from "@/components/common/relative-time"
import { ROW_LINK_LIFT, ROW_STRETCHED_LINK_CLASS } from "@/components/common/data-table"
import { Fragment, useMemo } from "react"

import type { AlertIncidentDocument, AlertIncidentHoldReason } from "@maple/domain/http"

import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { sortIncidents, TagChips, TagGroupHeaderRow } from "@/components/alerts/overview/shared"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import { groupByTag as groupItemsByTag } from "@/lib/alerts/tag-grouping"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { SectionHeading } from "@/components/common/section-heading"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"

const holdReasonTitle = (reason: AlertIncidentHoldReason): string => {
	switch (reason) {
		case "volume_collapsed":
			return "The breach stopped appearing, but traffic dropped well below its usual level. Resolves when data returns or after a few windows."
		case "no_data":
			return "The breach stopped appearing because the service stopped reporting. Resolves when telemetry returns or after six hours."
		case "sampling_changed":
			return "The breach stopped appearing while sampling changed. Resolves when the signal settles or after six hours."
		case "probe_failed":
			return "Maple could not verify telemetry for this service. Resolves on the next successful check."
	}
}

/**
 * Open incidents, severity-sorted, with tag inheritance from the owning rule.
 * Shown at the top of the overview whenever anything is firing.
 */
export function ActiveIncidentsTable({
	incidents,
	tagsByRuleId,
	grouped,
}: {
	/** Open incidents, already tag-filtered by the overview toolbar. */
	incidents: readonly AlertIncidentDocument[]
	tagsByRuleId: Map<string, readonly string[]>
	grouped: boolean
}) {
	const sorted = useMemo(() => sortIncidents(incidents), [incidents])
	const groups = useMemo(
		() => (grouped ? groupItemsByTag(sorted, (i) => tagsByRuleId.get(i.ruleId) ?? []) : null),
		[grouped, sorted, tagsByRuleId],
	)

	const renderRow = (incident: AlertIncidentDocument, key: string) => {
		const tags = tagsByRuleId.get(incident.ruleId) ?? []
		return (
			<TableRow key={key}>
				<TableCell>
					<AlertSeverityBadge severity={incident.severity} />
				</TableCell>
				<TableCell>
					<Link
						to="/alerts/$ruleId"
						params={{ ruleId: incident.ruleId }}
						className={cn("font-medium hover:underline", ROW_STRETCHED_LINK_CLASS)}
					>
						{incident.ruleName}
					</Link>
					{!grouped && <TagChips tags={tags} />}
				</TableCell>
				<TableCell>
					<span className="font-mono text-muted-foreground">{incident.groupKey ?? "all"}</span>
				</TableCell>
				<TableCell>
					{incident.holdReason != null ? (
						<span title={holdReasonTitle(incident.holdReason)} className={ROW_LINK_LIFT}>
							<AlertStatusBadge state="held" />
							{incident.heldSince ? (
								<RelativeTime
									value={incident.heldSince}
									tooltip="title"
									className="text-muted-foreground text-xs ml-1"
								/>
							) : null}
						</span>
					) : (
						<>
							<span className="font-mono text-severity-error">
								{formatSignalValue(incident.signalType, incident.lastObservedValue)}
							</span>
							<span className="text-muted-foreground text-xs ml-1">
								/ {formatSignalValue(incident.signalType, incident.threshold)}
							</span>
						</>
					)}
				</TableCell>
				<TableCell>
					{incident.lastTriggeredAt ? (
						<RelativeTime value={incident.lastTriggeredAt} tooltip="title" />
					) : (
						EMPTY_VALUE
					)}
				</TableCell>
				<TableCell>
					{incident.lastNotifiedAt ? (
						<RelativeTime value={incident.lastNotifiedAt} tooltip="title" />
					) : (
						"Never"
					)}
				</TableCell>
			</TableRow>
		)
	}

	return (
		<div className="space-y-3">
			<SectionHeading title="Active incidents" count={sorted.length.toLocaleString()} />

			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-[90px]">Severity</TableHead>
						<TableHead>Rule</TableHead>
						<TableHead>Group</TableHead>
						<TableHead>Current value</TableHead>
						<TableHead className="w-[110px]">Duration</TableHead>
						<TableHead>Last notified</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{sorted.length === 0 ? (
						<TableRow>
							<TableCell colSpan={6} className="p-0">
								<EmptyMessage>No active incidents match the selected tags.</EmptyMessage>
							</TableCell>
						</TableRow>
					) : groups ? (
						groups.map((group) => (
							<Fragment key={group.key}>
								<TagGroupHeaderRow
									label={group.label}
									count={group.count}
									noun="incident"
									colSpan={6}
								/>
								{group.items.map((incident) =>
									renderRow(incident, `${group.key}:${incident.id}`),
								)}
							</Fragment>
						))
					) : (
						sorted.map((incident) => renderRow(incident, incident.id))
					)}
				</TableBody>
			</Table>
		</div>
	)
}
