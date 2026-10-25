import { AlertRulePreviewResponse, IsoDateTimeString, isRangeComparator } from "@maple/domain/http"
import type { V2AlertRulePreviewParams } from "@maple/domain/http/v2"
import {
	buildRuleCreateParamsV2,
	deriveRuleQueryIssues,
	isFilledNumber,
	type RuleFormState,
	v2PreviewToResponse,
} from "@maple/web-data/alerts/form-utils"
import { mapBuilderChartFailure } from "@maple/web-data/alerts/preview-failure"
import { displayError } from "@maple/web-data/lib/error-messages"
import { normalizeTimestampInput } from "@maple/web-data/lib/timezone-format"
import { Effect, Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import { KeyedSchema } from "../../../data/keyed"
import { MapleApiV2Client } from "../../../platform/api-clients"

// The alert rule preview: the payload the preview is keyed by, the fetch, and the
// `{ preview, previewLoading, previewError }` reading.

/** A failed preview: the message to show, or `null` for "no data" (the friendly empty chart). */
export const PreviewFailure = Schema.Struct({ message: Schema.NullOr(Schema.String) })
export type PreviewFailure = typeof PreviewFailure.Type

export const PreviewSlot = KeyedSchema(AlertRulePreviewResponse, PreviewFailure)
export type PreviewSlot = typeof PreviewSlot.Type

const isPreviewQueryReady = (form: RuleFormState): boolean => {
	if (!Number.isFinite(Number(form.threshold))) return false
	if (isRangeComparator(form.comparator) && !Number.isFinite(Number(form.thresholdUpper))) return false
	if (form.signalType === "raw_query") {
		const sql = form.rawQuerySql.trim()
		if (sql.length === 0 || !sql.includes("$__orgFilter")) return false
	}
	return deriveRuleQueryIssues(form).length === 0
}

/** `toPreviewForm`: every field the preview ignores pinned, so typing a name never re-queries. */
export const toPreviewForm = (form: RuleFormState): RuleFormState => ({
	...form,
	name: "Untitled rule",
	notes: "",
	tags: [],
	destinationIds: [],
	escalation:
		form.escalation === null || !isFilledNumber(form.escalation.threshold)
			? null
			: { ...form.escalation, destinationIds: [] },
	notificationTitle: "",
	notificationBody: "",
	// Raw SQL previews chart under the longest limit, so picking an interval never re-queries.
	evaluationIntervalMinutes: "",
})

const toIso = (warehouseTime: string) =>
	IsoDateTimeString.make(new Date(normalizeTimestampInput(warehouseTime)).toISOString())

/** The request `useAlertRulePreview` sends for a form and window, `None` while it is not previewable. */
export const previewPayload = (
	form: RuleFormState,
	range: Readonly<{ startTime: string; endTime: string }>,
): Option.Option<V2AlertRulePreviewParams> =>
	isPreviewQueryReady(form)
		? Option.some({
				rule: buildRuleCreateParamsV2(toPreviewForm(form)),
				start_time: toIso(range.startTime),
				end_time: toIso(range.endTime),
			})
		: Option.none()

/** Without a payload: the form's first compile issue is the inline error. */
export const previewIssue = (form: RuleFormState | null): string | null =>
	form === null ? null : (deriveRuleQueryIssues(form)[0] ?? null)

export const fetchPreview = (payload: V2AlertRulePreviewParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.alertRules.preview({ payload })
		return v2PreviewToResponse(response)
	}).pipe(Effect.mapError((error): PreviewFailure => ({ message: mapBuilderChartFailure(displayError(error).message) })))

export interface PreviewState {
	readonly preview: AlertRulePreviewResponse | null
	readonly isLoading: boolean
	readonly error: string | null
}

/** A raw query too heavy to chart the range still answers, with its timing and no series. */
const seriesFailureMessage = (preview: AlertRulePreviewResponse): string | null =>
	preview.seriesFailure === undefined
		? null
		: `The query ${preview.seriesFailure === "query_too_much_memory" ? "ran out of memory" : "ran past 25 s"} charting this range. Pick a shorter preview range.`

/** The hook's result, read off the slot (`hasPayload` false is the no-payload branch). */
export const previewStateOf = (slot: PreviewSlot, hasPayload: boolean, issue: string | null): PreviewState =>
	!hasPayload
		? { preview: null, isLoading: false, error: issue }
		: AsyncData.match(slot.data, {
				onIdle: () => ({ preview: null, isLoading: true, error: null }),
				onLoading: () => ({ preview: null, isLoading: true, error: null }),
				onRefreshing: (preview) => ({ preview, isLoading: false, error: seriesFailureMessage(preview) }),
				onSuccess: (preview) => ({ preview, isLoading: false, error: seriesFailureMessage(preview) }),
				onFailure: (failure) => ({ preview: null, isLoading: false, error: failure.message }),
				onStale: ({ error }) => ({ preview: null, isLoading: false, error: error.message }),
			})
