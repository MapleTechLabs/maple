import type { AiEvaluationMeasures, AiEvaluationScore } from "@maple/domain/http"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import { formatNumber, formatPercentColumn } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "@maple/views/ui/empty"
import { inlineCode } from "@maple/views/ui/inline-code"
import type { TypographyTone } from "@maple/views/ui/typography"

// The evals pages' shared readings of a score set: pass rate, mean, a score's verdict tone.

/** How close to now a window must end for its scores read to run to now. */
const LIVE_WINDOW_SLACK_MS = 3_600_000

/**
 * The window the evals pages read scores over. A window ending near now (a preset like "Last 1
 * week", whose end the frame snaps down for the cache) reads to now: scores are written as they
 * happen, so the snapped end hid the newest ones until a Reload.
 */
export const scoresWindow = (
	window: { readonly startTime: string; readonly endTime: string },
	nowMs: number,
): { readonly startTime: string; readonly endTime: string } => {
	const endMs = parseWarehouseDateTime(window.endTime)
	return Number.isFinite(endMs) && endMs <= nowMs && nowMs - endMs < LIVE_WINDOW_SLACK_MS
		? { startTime: window.startTime, endTime: formatWarehouseDateTime(nowMs) }
		: window
}

/** An empty cell: no verdicts, or no numeric values. */
export const NO_VALUE = "-"

/** `pass / (pass + fail)`, absent when nothing in the set carried a verdict. */
export const passRateOf = (measures: AiEvaluationMeasures): number | undefined => {
	const decided = measures.passCount + measures.failCount
	return decided === 0 ? undefined : measures.passCount / decided
}

export const passRateLabel = (measures: AiEvaluationMeasures): string => {
	const rate = passRateOf(measures)
	return rate === undefined ? NO_VALUE : formatPercentColumn(rate)
}

/** The mean of the numeric scores, two decimals; absent when none had a value. */
export const meanScoreLabel = (measures: AiEvaluationMeasures): string =>
	measures.valueCount > 0 ? measures.avgValue.toFixed(2) : NO_VALUE

/** A pass rate's text tone: below 50% reads as failing, below 90% as a warning. */
export const passRateTone = (measures: AiEvaluationMeasures): TypographyTone => {
	const rate = passRateOf(measures)
	if (rate === undefined) return "subtle"
	return rate < 0.5 ? "error" : rate < 0.9 ? "warning" : "foreground"
}

export const verdictTone = (score: Pick<AiEvaluationScore, "verdict" | "errorType">): Tone =>
	score.errorType !== ""
		? "warn"
		: score.verdict === "fail"
			? "crit"
			: score.verdict === "pass"
				? "ok"
				: "neutral"

/** What a score says: its value and label, or the evaluation's own failure. */
export const scoreText = (score: Pick<AiEvaluationScore, "value" | "label" | "errorType">): string => {
	if (score.errorType !== "") return `Eval error: ${score.errorType}`
	const value = score.value === undefined ? undefined : formatNumber(score.value)
	if (value !== undefined && score.label !== "") return `${value} (${score.label})`
	return value ?? (score.label === "" ? NO_VALUE : score.label)
}

/** No scores in the window, and how they arrive. */
export const evalsEmptyState = <M>(h: HtmlBuilder<M>, title: string): Html =>
	empty(h, [
		emptyHeader(h, [
			emptyTitle(h, [title]),
			emptyDescription(h, [
				"Send scores as OpenTelemetry ",
				inlineCode(h, {}, ["gen_ai.evaluation.result"]),
				" events (a log record or span event on the graded span).",
			]),
		]),
	])
