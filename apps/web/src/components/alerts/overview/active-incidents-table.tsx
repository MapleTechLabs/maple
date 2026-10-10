import { Link, useNavigate } from "@tanstack/react-router"
import { RelativeTime } from "@/components/common/relative-time"
import { Fragment, useMemo } from "react"

import type { AlertIncidentDocument, AlertIncidentHoldReason } from "@maple/domain/http"

import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { sortIncidents, TagChips, TagGroupHeaderRow } from "@/components/alerts/overview/shared"
import { formatSignalValue } from "@/lib/alerts/form-utils"
import { groupByTag as groupItemsByTag } from "@/lib/alerts/tag-grouping"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { Badge } from "@maple/ui/components/ui/badge"
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	TruncatedCell,
} from "@maple/ui/components/ui/table"

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
	const navigate = useNavigate()

	const sorted = useMemo(() => sortIncidents(incidents), [incidents])
	const groups = useMemo(
		() => (grouped ? groupItemsByTag(sorted, (i) => tagsByRuleId.get(i.ruleId) ?? []) : null),
		[grouped, sorted, tagsByRuleId],
	)

	const renderRow = (incident: AlertIncidentDocument, key: string) => {
		const tags = tagsByRuleId.get(incident.ruleId) ?? []
		return (
			<TableRow
				key={key}
				className="cursor-pointer"
				onClick={() => navigate({ to: "/alerts/$ruleId", params: { ruleId: incident.ruleId } })}
			>
				<TableCell>
					<AlertSeverityBadge severity={incident.severity} />
				</TableCell>
				<TruncatedCell>
					<Link
						to="/alerts/$ruleId"
						params={{ ruleId: incident.ruleId }}
						className="block truncate font-medium hover:underline"
						title={incident.ruleName}
					>
						{incident.ruleName}
					</Link>
					{!grouped && <TagChips tags={tags} />}
				</TruncatedCell>
				<TableCell>
					<span
						className="block max-w-[180px] truncate font-mono text-muted-foreground"
						title={incident.groupKey ?? "all"}
					>
						{incident.groupKey ?? "all"}
					</span>
				</TableCell>
				<TableCell>
					{incident.holdReason != null ? (
						<span title={holdReasonTitle(incident.holdReason)}>
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
			<div className="flex items-center gap-2">
				<h2 className="text-lg font-semibold">Active incidents</h2>
				<Badge variant="secondary" className="rounded-full tabular-nums">
					{sorted.length}
				</Badge>
			</div>

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
							<TableCell colSpan={6} className="py-8 text-center text-muted-foreground text-sm">
								No active incidents match the selected tags.
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
