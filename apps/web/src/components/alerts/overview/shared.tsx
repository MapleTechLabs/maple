import type { AlertIncidentDocument } from "@maple/domain/http"

import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { pluralize } from "@maple/ui/lib/format"
import { TableCell, TableRow } from "@maple/ui/components/ui/table"

/** Group-header row for grouped tables (the delivery log's per-day groups). */
export function TagGroupHeaderRow({
	label,
	count,
	noun,
	colSpan,
}: {
	label: string
	count: number
	noun: string
	colSpan: number
}) {
	return (
		<TableRow>
			<TableCell colSpan={colSpan} className="bg-muted/30 py-1.5">
				<Eyebrow className="flex items-center gap-2">
					{label}
					<span className="tracking-normal normal-case text-muted-foreground/60 tabular-nums">
						{count} {pluralize(count, noun)}
					</span>
				</Eyebrow>
			</TableCell>
		</TableRow>
	)
}

/** Critical before warning, then most-recently-triggered first. */
const severityRank: Record<string, number> = { critical: 0, warning: 1 } satisfies Record<string, number>
export function sortIncidents(incidents: readonly AlertIncidentDocument[]): AlertIncidentDocument[] {
	return [...incidents].sort((a, b) => {
		const bySeverity = (severityRank[a.severity] ?? 2) - (severityRank[b.severity] ?? 2)
		if (bySeverity !== 0) return bySeverity
		const ta = a.lastTriggeredAt ? new Date(a.lastTriggeredAt).getTime() : 0
		const tb = b.lastTriggeredAt ? new Date(b.lastTriggeredAt).getTime() : 0
		return tb - ta
	})
}
