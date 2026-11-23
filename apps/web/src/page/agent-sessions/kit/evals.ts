import type { AiEvaluationMeasures, AiEvaluationScore } from "@maple/domain/http"
import { formatNumber, formatPercentColumn } from "@maple/ui/lib/format"
import type { Tone } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "@maple/views/ui/empty"
import { inlineCode } from "@maple/views/ui/inline-code"
import type { TypographyTone } from "@maple/views/ui/typography"

// The evals pages' shared readings of a score set: pass rate, mean, a score's verdict tone.

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
