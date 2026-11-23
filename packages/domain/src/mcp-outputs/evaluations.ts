import { Schema } from "effect"
import { AiEvaluationBreakdownRow, AiEvaluationScore, AiEvaluatorSummary } from "../http/ai-evaluations"
import { OutputTimeRange } from "./shared"

export const ListEvaluationsOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	/** One row per evaluator (`gen_ai.evaluation.name`), busiest first. */
	evaluators: Schema.Array(AiEvaluatorSummary),
})

export const GetEvaluationScoresOutput = Schema.Struct({
	timeRange: OutputTimeRange,
	name: Schema.String,
	verdict: Schema.optionalKey(Schema.Literals(["pass", "fail"])),
	/** Absent when the evaluator wrote nothing in the window. */
	summary: Schema.optionalKey(AiEvaluatorSummary),
	breakdown: Schema.Array(AiEvaluationBreakdownRow),
	/** The most recent scores, failing first. */
	scores: Schema.Array(AiEvaluationScore),
})
