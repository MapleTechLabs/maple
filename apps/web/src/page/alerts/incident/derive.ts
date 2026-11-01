import {
	type AlertIncidentDocument,
	AlertRulePreviewResponse,
	type AlertRuleDocument,
} from "@maple/domain/http"
import type { V2AlertRulePreviewParams } from "@maple/domain/http/v2"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { ruleToFormState } from "@maple/web-data/alerts/form-utils"
import {
	type AlertRuleStateRow,
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

/** The state rows of one rule (one per group). */
export const ruleStatesOf = (model: Model, ruleId: string): ReadonlyArray<AlertRuleStateRow> =>
	(model.states ?? []).filter((row) => row.rule_id === ruleId)

/** The incident and its rule, or `None` while the incidents list has not answered or lacks it. */
export const incidentViewOf = (model: Model): Option.Option<IncidentView> => {
	if (model.incidents === null || model.nowMs === null) return Option.none()
	const incidentRow = model.incidents.find((row) => row.id === model.incidentId)
	if (incidentRow === undefined) return Option.none()
	// Only this incident's rule is decoded: the org's other rules and incidents are never shown here.
	const incident = rowToAlertIncidentDocument(incidentRow)
	const ruleRow = (model.rules ?? []).find((row) => row.id === incidentRow.rule_id)
	const rule =
		ruleRow === undefined
			? null
			: rowToAlertRuleDocument(
					ruleRow,
					buildRuleStatesByRuleId(ruleStatesOf(model, incidentRow.rule_id)),
				)
	const now = model.nowMs
	const start = isoMs(incident.firstTriggeredAt)
	const pad = Math.max(30, (rule?.windowMinutes ?? 5) * 4) * MINUTE_MS
	const end = incident.resolvedAt != null ? Math.min(isoMs(incident.resolvedAt) + pad, now) : now
	const range = { start: start - pad, end: Math.max(end, start + MINUTE_MS) }
	return Option.some({
		incident,
		rule,
		ruleIncidents: model.incidents
			.filter((row) => row.rule_id === incidentRow.rule_id)
			.map(rowToAlertIncidentDocument),
		range,
		// An uptime rule has no query to replay: its signal is the monitor's checks.
		payload:
			rule === null || incident.signalType === "uptime"
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
