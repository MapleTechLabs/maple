import { AiEvaluatorSummary } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { AgentSessionEvalsSearch } from "../../../route/search"
import * as Frame from "../../kit/time-frame"

export const Evaluators = Schema.Array(AiEvaluatorSummary)
export type Evaluators = typeof Evaluators.Type

export const Model = Schema.Struct({
	search: AgentSessionEvalsSearch,
	frame: Frame.Model,
	evaluators: KeyedSchema(Evaluators, LoadFailure),
})
export type Model = typeof Model.Type
