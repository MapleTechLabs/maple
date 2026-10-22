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
	rowToAlertDestinationDocument,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@maple/web-data/collections/alerts"
import { normalizeTimestampInput } from "@maple/web-data/lib/timezone-format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { presetLabel } from "../../kit/time-controls"
import { previewPayload } from "../shared/preview"
import { isoMs } from "../shared/time"
import type { ChecksResponse, Model } from "./model"

export const DEFAULT_PRESET = "24h"

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

export const ruleOf = (model: Model): AlertRuleDocument | null => {
	const statesByRule = buildRuleStatesByRuleId(model.states ?? [])
	const row = (model.rules ?? []).find((candidate) => candidate.id === model.ruleId)
	return row === undefined ? null : rowToAlertRuleDocument(row, statesByRule)
}

/** Every incident of this rule, latest trigger first. */
export const ruleIncidentsOf = (model: Model): ReadonlyArray<AlertIncidentDocument> =>
	(model.incidents ?? [])
		.map(rowToAlertIncidentDocument)
		.filter((incident) => incident.ruleId === model.ruleId)
		.sort((a, b) => {
			const dateA = a.lastTriggeredAt ? new Date(a.lastTriggeredAt).getTime() : 0
			const dateB = b.lastTriggeredAt ? new Date(b.lastTriggeredAt).getTime() : 0
			return dateB - dateA
		})

export const destinationsOf = (model: Model): ReadonlyArray<AlertDestinationDocument> =>
	(model.destinations ?? []).map(rowToAlertDestinationDocument)

export const ruleDeliveriesOf = (model: Model): ReadonlyArray<AlertDeliveryEventDocument> =>
	AsyncData.getOrElse(model.deliveries.data, () => []).filter((event) => event.ruleId === model.ruleId)

export const checksPageOf = (model: Model): ChecksResponse | null =>
	Option.getOrNull(AsyncData.getData(model.checks.data))

/** The rail reads the summary buckets as checks; without a summary, the checks page itself. */
export const chartChecksOf = (
	rule: AlertRuleDocument,
	page: ChecksResponse | null,
): ReadonlyArray<AlertCheckDocument> => {
	if (page === null) return []
	if (page.summary.points.length === 0) return page.checks
	return page.summary.points.map((point) => {
		const status: AlertCheckDocument["status"] =
			point.errorCount > 0
				? "error"
				: point.breachedCount > 0
					? "breached"
					: point.healthyCount > 0
						? "healthy"
						: "skipped"
		const bucketStart = IsoDateTimeString.make(point.bucket)
		const bucketEnd = IsoDateTimeString.make(
			new Date(isoMs(point.bucket) + page.summary.bucketSeconds * 1000).toISOString(),
		)
		return new AlertCheckDocument({
			timestamp: bucketStart,
			groupKey: point.groupKey,
			status,
			skipReason: null,
			signalType: rule.signalType,
			comparator: rule.comparator,
			threshold: point.threshold,
			thresholdUpper: rule.thresholdUpper,
			observedValue: point.observedValue,
			sampleCount: point.totalCount,
			windowMinutes: Math.max(1, Math.round(page.summary.bucketSeconds / 60)),
			windowStart: bucketStart,
			windowEnd: bucketEnd,
			consecutiveBreaches: 0,
			consecutiveHealthy: 0,
			incidentId: null,
			incidentTransition: point.transitionCount > 0 ? "continued" : "none",
			level: null,
			evaluationDurationMs: 0,
			errorMessage: null,
			errorCategory: null,
		})
	})
}

export const payloadOf = (model: Model, rule: AlertRuleDocument | null): Option.Option<V2AlertRulePreviewParams> =>
	rule === null || model.window === null ? Option.none() : previewPayload(ruleToFormState(rule), model.window)

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
