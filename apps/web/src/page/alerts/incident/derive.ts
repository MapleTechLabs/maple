import {
	type AlertIncidentDocument,
	AlertRulePreviewResponse,
	type AlertRuleDocument,
	type AlertRuleId,
	IsoDateTimeString,
	isManagedSignalType,
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
import { Option, Array as Arr } from "effect"
import { lastBy } from "../../kit/last-by"
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
	/** The rule's recorded checks over `range`; `None` without a rule or for a monitor or SLO incident. */
	readonly checksQuery: Option.Option<
		Readonly<{ ruleId: AlertRuleId; since: IsoDateTimeString; until: IsoDateTimeString }>
	>
}

/** The state rows of one rule (one per group). */
export const ruleStatesOf = (
	model: Pick<Model, "states">,
	ruleId: string,
): ReadonlyArray<AlertRuleStateRow> => Arr.filter(model.states ?? [], (row) => row.rule_id === ruleId)

type ViewKey = Pick<Model, "incidents" | "rules" | "states" | "incidentId" | "nowMs">

/** The incident and its rule, or `None` while the incidents list has not answered or lacks it. */
export const incidentViewOf = (model: Model): Option.Option<IncidentView> =>
	incidentViewFor([model.incidents, model.rules, model.states, model.incidentId, model.nowMs])

const incidentViewFor = lastBy(
	([incidents, rules, states, incidentId, nowMs]: readonly [
		ViewKey["incidents"],
		ViewKey["rules"],
		ViewKey["states"],
		ViewKey["incidentId"],
		ViewKey["nowMs"],
	]) => deriveIncidentView({ incidents, rules, states, incidentId, nowMs }),
)

const deriveIncidentView = (model: ViewKey): Option.Option<IncidentView> => {
	if (model.incidents === null || model.nowMs === null) return Option.none()
	const foundIncident = Arr.findFirst(model.incidents, (row) => row.id === model.incidentId)
	if (Option.isNone(foundIncident)) return Option.none()
	const incidentRow = foundIncident.value
	// Only this incident's rule is decoded: the org's other rules and incidents are never shown here.
	const incident = rowToAlertIncidentDocument(incidentRow)
	const rule = Option.match(
		Arr.findFirst(model.rules ?? [], (row) => row.id === incidentRow.rule_id),
		{
			onNone: () => null,
			onSome: (ruleRow) =>
				rowToAlertRuleDocument(
					ruleRow,
					buildRuleStatesByRuleId(ruleStatesOf(model, incidentRow.rule_id)),
				),
		},
	)
	const now = model.nowMs
	const start = isoMs(incident.firstTriggeredAt)
	const pad = Math.max(30, (rule?.windowMinutes ?? 5) * 4) * MINUTE_MS
	const end = incident.resolvedAt != null ? Math.min(isoMs(incident.resolvedAt) + pad, now) : now
	const range = { start: start - pad, end: Math.max(end, start + MINUTE_MS) }
	return Option.some({
		incident,
		rule,
		ruleIncidents: Arr.map(
			Arr.filter(model.incidents, (row) => row.rule_id === incidentRow.rule_id),
			rowToAlertIncidentDocument,
		),
		range,
		// An anomaly rule records only severity codes: the detector's own series is the evidence.
		checksQuery:
			rule === null || isManagedSignalType(incident.signalType) || incident.signalType === "anomaly"
				? Option.none()
				: Option.some({
						ruleId: rule.id,
						since: IsoDateTimeString.make(new Date(range.start).toISOString()),
						until: IsoDateTimeString.make(new Date(range.end).toISOString()),
					}),
		// A monitor's or SLO's rule has no query to replay: its signal is the checks or the burn rate.
		payload:
			rule === null || isManagedSignalType(incident.signalType) || incident.signalType === "anomaly"
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
	const series = Arr.filter(preview.series, (s) => s.groupKey === incident.groupKey)
	if (series.length === 0 || series.length === preview.series.length) return preview
	return new AlertRulePreviewResponse({ ...preview, series, wouldFire: [] })
}

/** `clockAtSync`: the minute the incident was last seen. */
export const minuteOf = (nowMs: number): number => Math.floor(nowMs / MINUTE_MS) * MINUTE_MS
