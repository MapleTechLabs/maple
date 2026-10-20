import type { AlertIncidentDocument } from "@maple/domain/http"
import { isoMs } from "./time"

const SEVERITY_RANK = new Map<string, number>([
	["critical", 0],
	["warning", 1],
])

/** Critical before warning, then most-recently-triggered first. */
export const sortIncidents = (incidents: ReadonlyArray<AlertIncidentDocument>): Array<AlertIncidentDocument> =>
	[...incidents].sort((a, b) => {
		const bySeverity = (SEVERITY_RANK.get(a.severity) ?? 2) - (SEVERITY_RANK.get(b.severity) ?? 2)
		if (bySeverity !== 0) return bySeverity
		const ta = a.lastTriggeredAt ? isoMs(a.lastTriggeredAt) : 0
		const tb = b.lastTriggeredAt ? isoMs(b.lastTriggeredAt) : 0
		return tb - ta
	})
