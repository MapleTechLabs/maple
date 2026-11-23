import {
	AiEvaluationBreakdownRow,
	AiEvaluationBucket,
	AiEvaluationScore,
	AiEvaluatorSummary,
} from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { AgentSessionEvaluatorSearch } from "../../../route/search"
import * as Frame from "../../kit/time-frame"

/** One evaluator's read: summary (absent with no scores), series, breakdown and latest scores. */
export const EvaluatorDetail = Schema.Struct({
	summary: Schema.optionalKey(AiEvaluatorSummary),
	series: Schema.Array(AiEvaluationBucket),
	breakdown: Schema.Array(AiEvaluationBreakdownRow),
	scores: Schema.Array(AiEvaluationScore),
})
export type EvaluatorDetail = typeof EvaluatorDetail.Type

export const Model = Schema.Struct({
	name: Schema.String,
	search: AgentSessionEvaluatorSearch,
	frame: Frame.Model,
	detail: KeyedSchema(EvaluatorDetail, LoadFailure),
})
export type Model = typeof Model.Type
