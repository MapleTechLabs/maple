import { type AlertIncidentDocument, AlertRulePreviewResponse, type AlertRuleDocument } from "@maple/domain/http"
import type { V2AlertRulePreviewParams } from "@maple/domain/http/v2"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { ruleToFormState } from "@maple/web-data/alerts/form-utils"
import {
	buildRuleStatesByRuleId,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@maple/web-data/collections/alerts"
import { Option } from "effect"
import { previewPayload } from "../shared/preview"
import { isoMs } from "../shared/time"
import type { Model } from "./model"

const MINUTE_MS = 60_000

export interface IncidentView {
	readonly incident: AlertIncidentDocument
	readonly rule: AlertRuleDocument | null
	readonly ruleIncidents: ReadonlyArray<AlertIncidentDocument>
	readonly range: Readonly<{ start: number; end: number }>
	readonly payload: Option.Option<V2AlertRulePreviewParams>
}

/** The incident and its rule, or `None` while the incidents list has not answered or lacks it. */
export const incidentViewOf = (model: Model): Option.Option<IncidentView> => {
	if (model.incidents === null || model.nowMs === null) return Option.none()
	const incidents = model.incidents.map(rowToAlertIncidentDocument)
	const incident = incidents.find((candidate) => candidate.id === model.incidentId)
	if (incident === undefined) return Option.none()
	const statesByRule = buildRuleStatesByRuleId(model.states ?? [])
	const rules = (model.rules ?? []).map((row) => rowToAlertRuleDocument(row, statesByRule))
	const rule = rules.find((candidate) => candidate.id === incident.ruleId) ?? null
	const now = model.nowMs
	const start = isoMs(incident.firstTriggeredAt)
	const pad = Math.max(30, (rule?.windowMinutes ?? 5) * 4) * MINUTE_MS
	const end = incident.resolvedAt != null ? Math.min(isoMs(incident.resolvedAt) + pad, now) : now
	const range = { start: start - pad, end: Math.max(end, start + MINUTE_MS) }
	return Option.some({
		incident,
		rule,
		ruleIncidents: incidents.filter((candidate) => candidate.ruleId === incident.ruleId),
		range,
		payload:
			rule === null
				? Option.none()
				: previewPayload(ruleToFormState(rule), {
						startTime: formatWarehouseDateTime(range.start),
						endTime: formatWarehouseDateTime(range.end),
					}),
	})
}

/** A grouped rule previews every group; the incident is about one of them. */
export const groupPreviewOf = (
	preview: AlertRulePreviewResponse | null,
	incident: AlertIncidentDocument,
): AlertRulePreviewResponse | null => {
	if (preview == null || incident.groupKey == null) return preview
	const series = preview.series.filter((s) => s.groupKey === incident.groupKey)
	if (series.length === 0 || series.length === preview.series.length) return preview
	return new AlertRulePreviewResponse({ ...preview, series, wouldFire: [] })
}

/** `clockAtSync`: the minute the incident was last seen. */
export const minuteOf = (nowMs: number): number => Math.floor(nowMs / MINUTE_MS) * MINUTE_MS
