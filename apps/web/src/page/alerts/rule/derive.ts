import {
	AlertCheckDocument,
	type AlertDeliveryEventDocument,
	type AlertDestinationDocument,
	type AlertIncidentDocument,
	type AlertRuleDocument,
	IsoDateTimeString,
} from "@maple/domain/http"
import type { V2AlertRulePreviewParams } from "@maple/domain/http/v2"
import { ruleToFormState } from "@maple/web-data/alerts/form-utils"
import {
	buildRuleStatesByRuleId,
	rowsToAlertDestinationDocuments,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@maple/web-data/collections/alerts"
import { normalizeTimestampInput } from "@maple/web-data/lib/timezone-format"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import { lastBy } from "../../kit/last-by"
import { type PresetValue, presetLabel } from "../../kit/time-controls"
import { summaryChecksOf } from "../shared/check-summary"
import { previewPayload } from "../shared/preview"
import type { ChecksResponse, Model } from "./model"

export const DEFAULT_PRESET: PresetValue = "24h"

/** `formatBucketSpan`. */
export const formatBucketSpan = (seconds: number): string => {
	if (seconds < 60) return `${Math.round(seconds)}s`
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = minutes / 60
	return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

export const isoOf = (warehouseTime: string): IsoDateTimeString =>
	IsoDateTimeString.make(new Date(normalizeTimestampInput(warehouseTime)).toISOString())

const ruleFor = lastBy(
	([rules, states, id]: readonly [
		Model["rules"],
		Model["states"],
		Model["ruleId"],
	]): AlertRuleDocument | null => {
		const row = Arr.findFirst(rules ?? [], (candidate) => candidate.id === id)
		if (Option.isNone(row)) return null
		const own = Arr.filter(states ?? [], (state) => state.rule_id === id)
		return rowToAlertRuleDocument(row.value, buildRuleStatesByRuleId(own))
	},
)

/** This rule's document; recomputed only when the synced rules or states change. */
export const ruleOf = (model: Model): AlertRuleDocument | null =>
	ruleFor([model.rules, model.states, model.ruleId])

const ruleIncidentsFor = lastBy(
	([incidents, id]: readonly [Model["incidents"], Model["ruleId"]]): ReadonlyArray<AlertIncidentDocument> =>
		Arr.map(
			Arr.filter(incidents ?? [], (row) => row.rule_id === id),
			rowToAlertIncidentDocument,
		).sort((a, b) => isoTime(b.lastTriggeredAt) - isoTime(a.lastTriggeredAt)),
)

const isoTime = (iso: string | null): number => (iso ? new Date(iso).getTime() : 0)

/** Every incident of this rule, latest trigger first. Only this rule's rows are decoded. */
export const ruleIncidentsOf = (model: Model): ReadonlyArray<AlertIncidentDocument> =>
	ruleIncidentsFor([model.incidents, model.ruleId])

const destinationsFor = lastBy(
	([rows]: readonly [Model["destinations"]]): ReadonlyArray<AlertDestinationDocument> =>
		rowsToAlertDestinationDocuments(rows ?? []),
)

export const destinationsOf = (model: Model): ReadonlyArray<AlertDestinationDocument> =>
	destinationsFor([model.destinations])

export const ruleDeliveriesOf = (model: Model): ReadonlyArray<AlertDeliveryEventDocument> =>
	Arr.filter(
		AsyncData.getOrElse(model.deliveries.data, () => []),
		(event) => event.ruleId === model.ruleId,
	)

export const checksPageOf = (model: Model): ChecksResponse | null =>
	Option.getOrNull(AsyncData.getData(model.checks.data))

/** The rail reads the summary buckets as checks; without a summary, the checks page itself. */
export const chartChecksOf = (
	rule: AlertRuleDocument,
	page: ChecksResponse | null,
): ReadonlyArray<AlertCheckDocument> => {
	if (page === null) return []
	return page.summary.points.length === 0 ? page.checks : summaryChecksOf(rule, page.summary)
}

export const payloadOf = (
	model: Model,
	rule: AlertRuleDocument | null,
): Option.Option<V2AlertRulePreviewParams> =>
	rule === null || model.window === null
		? Option.none()
		: previewPayload(ruleToFormState(rule), model.window)

/** The picker's label: a preset's, else the range (not yet zone-aware). */
export const rangeLabelOf = (model: Model): string =>
	model.search.startTime !== undefined && model.search.endTime !== undefined
		? `${model.search.startTime} - ${model.search.endTime}`
		: presetLabel(model.search.timePreset ?? DEFAULT_PRESET)

export const timelineRangeOf = (model: Model) =>
	model.window === null
		? { min: 0, max: 0 }
		: {
				min: new Date(normalizeTimestampInput(model.window.startTime)).getTime(),
				max: new Date(normalizeTimestampInput(model.window.endTime)).getTime(),
			}
