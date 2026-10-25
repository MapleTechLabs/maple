import {
	AlertRulePreviewResponse,
	UNGROUPED_GROUP_KEY,
	type AlertIncidentDocument,
	type AlertRulePreviewSeries,
	type AlertSkipReason,
} from "@maple/domain/http"

import {
	buildRuleCreateParamsV2,
	comparatorLabels,
	comparatorSupportsTiers,
	displaySignalType,
	formThresholdToDomain,
	formatSignalValue,
	isRangeComparator,
	optionalFormThreshold,
	RAW_QUERY_REDUCER_LABELS,
	signalLabels,
	type RuleFormState,
} from "./form-utils"

/** How many groups the editor's preview chart draws before collapsing the rest into "N more". */
export const PREVIEW_GROUP_LIMIT = 3

export interface FocusedPreview {
	readonly preview: AlertRulePreviewResponse | null
	readonly shownGroups: readonly string[]
	readonly hiddenGroupCount: number
}

/**
 * Narrow a grouped preview to the groups closest to firing: most breached
 * windows first, then the smallest gap to the threshold. The would-fire spans
 * stay whole so the verdict still counts every group.
 */
export function focusPreviewOnClosestGroups(
	preview: AlertRulePreviewResponse | null,
	limit: number = PREVIEW_GROUP_LIMIT,
): FocusedPreview {
	if (preview === null || preview.series.length <= limit) {
		return { preview, shownGroups: [], hiddenGroupCount: 0 }
	}
	const ranked = preview.series
		.map((series) => ({ series, ...thresholdProximity(series, preview) }))
		.sort((a, b) => b.breaches - a.breaches || a.gap - b.gap)
		.slice(0, limit)
		.map((entry) => entry.series)
	return {
		preview: new AlertRulePreviewResponse({ ...preview, series: ranked }),
		shownGroups: ranked.map((series) => series.groupKey),
		hiddenGroupCount: preview.series.length - ranked.length,
	}
}

function thresholdProximity(
	series: AlertRulePreviewSeries,
	preview: AlertRulePreviewResponse,
): { breaches: number; gap: number } {
	const scale = Math.max(Math.abs(preview.threshold), Number.EPSILON)
	const bounds = [preview.threshold, ...(preview.thresholdUpper === null ? [] : [preview.thresholdUpper])]
	const values = series.points.flatMap((point) => (point.value === null ? [] : [point.value]))
	return {
		breaches: series.points.filter((point) => point.status === "breached").length,
		gap: Math.min(
			Number.POSITIVE_INFINITY,
			...values.flatMap((value) => bounds.map((bound) => Math.abs(value - bound) / scale)),
		),
	}
}

export interface SkippedWindows {
	readonly total: number
	readonly skipped: number
	readonly byReason: Readonly<Record<AlertSkipReason, number>>
}

/** Windows the evaluator would have skipped, across every group, by reason. */
export function countSkippedWindows(preview: AlertRulePreviewResponse | null): SkippedWindows {
	const empty: SkippedWindows = {
		total: 0,
		skipped: 0,
		byReason: { below_min_samples: 0, no_data: 0, no_value: 0 },
	}
	if (preview === null) return empty
	return preview.series
		.flatMap((series) => series.points)
		.reduce(
			(acc, point) =>
				point.status !== "skipped"
					? { ...acc, total: acc.total + 1 }
					: {
							total: acc.total + 1,
							skipped: acc.skipped + 1,
							byReason: {
								...acc.byReason,
								[point.skipReason ?? "no_data"]:
									acc.byReason[point.skipReason ?? "no_data"] + 1,
							},
						},
			empty,
		)
}

/**
 * Open incidents of the rule that the draft would not keep open: their group
 * has no would-fire span reaching the last complete window of the draft's
 * replay. Unknown (empty) while the draft preview is not loaded.
 */
export function incidentsClearedByDraft(
	incidents: readonly AlertIncidentDocument[],
	draftPreview: AlertRulePreviewResponse | null,
): AlertIncidentDocument[] {
	if (draftPreview === null) return []
	const windowMs = draftPreview.windowMinutes * 60_000
	const stillOpen = new Set(
		draftPreview.series
			.filter((series) => {
				const lastComplete = series.points
					.filter((point) => point.provisional !== true)
					.reduce((max, point) => Math.max(max, Date.parse(point.bucket)), Number.NEGATIVE_INFINITY)
				return draftPreview.wouldFire.some(
					(span) =>
						span.groupKey === series.groupKey && Date.parse(span.end) >= lastComplete + windowMs,
				)
			})
			.map((series) => series.groupKey),
	)
	return incidents.filter(
		(incident) => incident.status === "open" && !stillOpen.has(incident.groupKey ?? UNGROUPED_GROUP_KEY),
	)
}

export interface RuleFieldChange {
	readonly field: string
	readonly before: string
	readonly after: string
}

/**
 * What an edit changes, field by field, in the form's own display units. Built
 * from the save payload so a field only counts as changed when saving it would.
 */
export function diffRuleForms(saved: RuleFormState, draft: RuleFormState): RuleFieldChange[] {
	const a = buildRuleCreateParamsV2(saved)
	const b = buildRuleCreateParamsV2(draft)
	const threshold = (form: RuleFormState, value: number | null | undefined) =>
		value == null ? "none" : formatSignalValue(displaySignalType(form), value)
	// The escalation tier only: a one-tier critical rule reports through the plain threshold rows.
	const critical = (params: typeof a) => params.thresholds?.[1]
	const list = (values: readonly string[] | null | undefined) =>
		values == null || values.length === 0 ? "all" : values.join(", ")
	const query = (form: RuleFormState) =>
		form.signalType === "builder_query"
			? `${form.queryBuilderDraft.aggregation} where ${form.queryBuilderDraft.whereClause || "(none)"}`
			: form.signalType === "raw_query"
				? "SQL"
				: signalLabels[form.signalType]

	const rows: Array<RuleFieldChange & { same: boolean }> = [
		{
			field: "Query",
			before: query(saved),
			after: query(draft),
			same:
				a.signal_type === b.signal_type &&
				JSON.stringify(a.query_builder_draft) === JSON.stringify(b.query_builder_draft) &&
				a.raw_query_sql === b.raw_query_sql,
		},
		{
			field: "Reducer",
			before: a.raw_query_reducer == null ? "none" : RAW_QUERY_REDUCER_LABELS[a.raw_query_reducer],
			after: b.raw_query_reducer == null ? "none" : RAW_QUERY_REDUCER_LABELS[b.raw_query_reducer],
			same: a.raw_query_reducer === b.raw_query_reducer,
		},
		{
			field: "Services",
			before: list(a.service_names),
			after: list(b.service_names),
			same: list(a.service_names) === list(b.service_names),
		},
		{
			field: "Environments",
			before: list(a.environments),
			after: list(b.environments),
			same: list(a.environments) === list(b.environments),
		},
		{
			field: "Split by",
			before: list(a.group_by),
			after: list(b.group_by),
			same: list(a.group_by) === list(b.group_by),
		},
		{
			field: "Condition",
			before: comparatorLabels[a.comparator],
			after: comparatorLabels[b.comparator],
			same: a.comparator === b.comparator,
		},
		{
			field: "Threshold",
			before: threshold(saved, a.threshold),
			after: threshold(draft, b.threshold),
			same: a.threshold === b.threshold,
		},
		{
			field: "Critical threshold",
			before: threshold(saved, critical(a)?.value),
			after: threshold(draft, critical(b)?.value),
			same: critical(a)?.value === critical(b)?.value,
		},
		{
			field: "Recovery",
			before: threshold(saved, a.thresholds?.[0]?.recovery_value),
			after: threshold(draft, b.thresholds?.[0]?.recovery_value),
			same: a.thresholds?.[0]?.recovery_value === b.thresholds?.[0]?.recovery_value,
		},
		{
			field: "Critical recovery",
			before: threshold(saved, critical(a)?.recovery_value),
			after: threshold(draft, critical(b)?.recovery_value),
			same: critical(a)?.recovery_value === critical(b)?.recovery_value,
		},
		{
			field: "Upper threshold",
			before: threshold(saved, a.threshold_upper),
			after: threshold(draft, b.threshold_upper),
			same:
				a.threshold_upper === b.threshold_upper ||
				(!isRangeComparator(a.comparator) && !isRangeComparator(b.comparator)),
		},
		{
			field: "Window",
			before: `${a.window_minutes}m`,
			after: `${b.window_minutes}m`,
			same: a.window_minutes === b.window_minutes,
		},
		{
			field: "Check every",
			before: a.evaluation_interval_minutes == null ? "Auto" : `${a.evaluation_interval_minutes}m`,
			after: b.evaluation_interval_minutes == null ? "Auto" : `${b.evaluation_interval_minutes}m`,
			same: a.evaluation_interval_minutes === b.evaluation_interval_minutes,
		},
		{
			field: "Checks to fire",
			before: String(a.consecutive_breaches_required),
			after: String(b.consecutive_breaches_required),
			same: a.consecutive_breaches_required === b.consecutive_breaches_required,
		},
		{
			field: "Out of last",
			before: a.breaches_out_of == null ? "in a row" : `${a.breaches_out_of} checks`,
			after: b.breaches_out_of == null ? "in a row" : `${b.breaches_out_of} checks`,
			same: a.breaches_out_of === b.breaches_out_of,
		},
		{
			field: "Checks to resolve",
			before: String(a.consecutive_healthy_required),
			after: String(b.consecutive_healthy_required),
			same: a.consecutive_healthy_required === b.consecutive_healthy_required,
		},
		{
			field: "Min samples",
			before: String(a.minimum_sample_count),
			after: String(b.minimum_sample_count),
			same: a.minimum_sample_count === b.minimum_sample_count,
		},
		{
			field: "No data",
			before: a.alert_on_no_data ? "alert" : "skip",
			after: b.alert_on_no_data ? "alert" : "skip",
			same: a.alert_on_no_data === b.alert_on_no_data,
		},
		{
			field: "Apdex target",
			before: `${a.apdex_threshold_ms ?? "none"}`,
			after: `${b.apdex_threshold_ms ?? "none"}`,
			same: a.apdex_threshold_ms === b.apdex_threshold_ms,
		},
		{
			field: "Severity",
			before: a.severity ?? "",
			after: b.severity ?? "",
			same: a.severity === b.severity,
		},
		{
			field: "Renotify",
			before: `${a.renotify_interval_minutes}m`,
			after: `${b.renotify_interval_minutes}m`,
			same: a.renotify_interval_minutes === b.renotify_interval_minutes,
		},
		{
			field: "Destinations",
			before: String(a.destination_ids?.length ?? 0),
			after: String(b.destination_ids?.length ?? 0),
			same:
				[...(a.destination_ids ?? [])].sort().join() === [...(b.destination_ids ?? [])].sort().join(),
		},
		{
			field: "Critical destinations",
			before: String(critical(a)?.destination_ids.length ?? 0),
			after: String(critical(b)?.destination_ids.length ?? 0),
			same:
				[...(critical(a)?.destination_ids ?? [])].sort().join() ===
				[...(critical(b)?.destination_ids ?? [])].sort().join(),
		},
		{ field: "Name", before: a.name, after: b.name, same: a.name === b.name },
		{
			field: "Notes",
			before: a.notes ?? "",
			after: b.notes ?? "",
			same: (a.notes ?? "") === (b.notes ?? ""),
		},
		{
			field: "Tags",
			before: saved.tags.join(", "),
			after: draft.tags.join(", "),
			same: saved.tags.join() === draft.tags.join(),
		},
		{
			field: "Message",
			before: a.notification_template === null ? "default" : "custom",
			after: b.notification_template === null ? "default" : "custom",
			same: JSON.stringify(a.notification_template) === JSON.stringify(b.notification_template),
		},
		{
			field: "Enabled",
			before: String(a.enabled),
			after: String(b.enabled),
			same: a.enabled === b.enabled,
		},
	]
	return rows.filter((row) => !row.same).map(({ same: _same, ...change }) => change)
}

/** The draft's threshold as a domain value, for the chart and the verdict. */
export function draftThresholds(form: RuleFormState): {
	threshold: number
	upper: number | null
	critical: number | null
} {
	const threshold = formThresholdToDomain(form, form.threshold)
	const upper =
		form.thresholdUpper.trim().length > 0 && Number.isFinite(Number(form.thresholdUpper))
			? formThresholdToDomain(form, form.thresholdUpper)
			: null
	const escalation = comparatorSupportsTiers(form.comparator) ? form.escalation : null
	const critical = escalation === null ? null : optionalFormThreshold(form, escalation.threshold)
	return { threshold: Number.isFinite(threshold) ? threshold : 0, upper, critical }
}
