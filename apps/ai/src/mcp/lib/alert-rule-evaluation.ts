/** What a rule write can tell the caller about its first evaluation, from a short preview. */
import { Clock, DateTime, Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { IsoDateTimeString } from "@maple/domain"
import {
	AlertRulePreviewRequest,
	type AlertRulePreviewResponse,
	type AlertRuleUpsertRequest,
} from "@maple/domain/http"
import type { AlertRuleFirstEvaluation } from "@maple/domain/mcp-outputs"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { CurrentMcpTenant } from "./query-warehouse"

/** The alerting worker evaluates every enabled rule on a one-minute cron. */
export const SCHEDULER_TICK_MS = 60_000
const PREVIEW_TIMEOUT = "15 seconds"

interface SamplePoint {
	readonly sampleCount: number
	readonly skipReason?: string | null | undefined
}

/**
 * A rule whose windows never reach `minimumSampleCount` is skipped every cycle and never fires.
 * Windows with no data at all do not count either way.
 */
export const minSampleCountWarning = (
	points: ReadonlyArray<SamplePoint>,
	minimumSampleCount: number,
): string | null => {
	if (minimumSampleCount <= 0) return null
	const withData = Arr.filter(points, (p) => p.skipReason !== "no_data" && p.sampleCount > 0)
	if (withData.length === 0) return null
	const below = Arr.filter(withData, (p) => p.sampleCount < minimumSampleCount)
	if (below.length < withData.length) return null
	const counts = Arr.map(withData, (p) => p.sampleCount)
	const lo = Math.min(...counts)
	const hi = Math.max(...counts)
	const seen = lo === hi ? `${lo}` : `${lo}-${hi}`
	return `minimum_sample_count is ${minimumSampleCount} but recent windows saw only ${seen} samples, so every check is skipped (below_min_samples) and the rule can never fire. Lower minimum_sample_count to ${hi} or less, or widen window_minutes.`
}

const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)
const isoAt = (ms: number) => decodeIso(Str.replace(/\.\d{3}Z$/, "Z")(new Date(ms).toISOString()))
const decodePreviewRequest = Schema.decodeUnknownEffect(AlertRulePreviewRequest)

type PreviewOutcome = { readonly error: string } | { readonly response: AlertRulePreviewResponse }
const failed = (error: string): PreviewOutcome => ({ error })
const succeeded = (response: AlertRulePreviewResponse): PreviewOutcome => ({ response })
const noWarnings: ReadonlyArray<string> = []

const errorMessage = (error: unknown): string =>
	typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
		? error.message
		: String(error)

/**
 * Previews the saved definition over its last few windows. Best effort: a failed or slow preview
 * becomes `previewError`, never a failed write.
 */
export const firstEvaluation = Effect.fn("McpTool.alertFirstEvaluation")(function* (
	rule: AlertRuleUpsertRequest,
	enabled: boolean,
) {
	const tenant = yield* CurrentMcpTenant
	const alerts = yield* AlertsService
	const now = yield* Clock.currentTimeMillis
	const nextEvaluationAt = enabled
		? DateTime.formatIso(
				DateTime.makeUnsafe(Math.ceil((now + 1) / SCHEDULER_TICK_MS) * SCHEDULER_TICK_MS),
			)
		: null
	// An anomaly rule reads the detector's open incidents, not a query, so there is nothing to preview.
	if (rule.signalType === "anomaly") {
		const evaluation: typeof AlertRuleFirstEvaluation.Type = { nextEvaluationAt, current: [] }
		return { evaluation, warnings: noWarnings }
	}
	const lookbackMs = Math.max(rule.windowMinutes * 6, 60) * 60_000

	const preview = yield* decodePreviewRequest({
		rule,
		startTime: isoAt(now - lookbackMs),
		endTime: isoAt(now),
	}).pipe(
		Effect.flatMap((request) => alerts.previewRule(tenant.orgId, tenant.roles, request)),
		Effect.timeoutOption(PREVIEW_TIMEOUT),
		Effect.map((option) =>
			Option.match(option, {
				onNone: () => failed("the preview ran past its time limit"),
				onSome: succeeded,
			}),
		),
		Effect.catch((error) => Effect.succeed(failed(errorMessage(error)))),
	)

	if ("error" in preview) {
		const evaluation: typeof AlertRuleFirstEvaluation.Type = {
			nextEvaluationAt,
			current: [],
			previewError: preview.error,
		}
		return { evaluation, warnings: noWarnings }
	}

	const current = Arr.flatMap(preview.response.series, (series) => {
		const complete = Arr.filter(series.points, (p) => p.provisional !== true)
		const latest = complete.at(-1) ?? series.points.at(-1)
		return latest === undefined
			? []
			: [
					{
						groupKey: series.groupKey,
						window: latest.bucket,
						status: latest.status,
						skipReason: latest.skipReason ?? null,
						value: latest.value,
						sampleCount: latest.sampleCount,
					},
				]
	})
	const warning = minSampleCountWarning(
		Arr.flatMap(preview.response.series, (s) => s.points),
		rule.minimumSampleCount ?? 0,
	)
	const evaluation: typeof AlertRuleFirstEvaluation.Type = { nextEvaluationAt, current }
	return { evaluation, warnings: warning === null ? [] : [warning] }
})
