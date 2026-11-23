// The warehouse reads behind `/agent-sessions/evals`, an evaluator's detail page
// and a session's scores. Timestamps stay warehouse literals; views read them
// with `toEpochMs`.

import { Effect, Schema } from "effect"
import {
	AI_EVALUATION_SESSION_MAX_TRACES,
	GetAiEvaluatorRequest,
	GetAiSessionEvaluationsRequest,
	ListAiEvaluatorsRequest,
} from "@maple/domain/http"
import { EVALUATION_NAME_MAX } from "@maple/domain/gen-ai-evaluation"

import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

const EvaluationWindowInput = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
})
export type EvaluationWindowInput = Schema.Schema.Type<typeof EvaluationWindowInput>

// Bounds mirror the domain request so a bad value is a decode failure, not a defect.
const AiEvaluatorInput = Schema.Struct({
	...EvaluationWindowInput.fields,
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(EVALUATION_NAME_MAX)),
	bucketSeconds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
	verdict: Schema.optional(Schema.Literals(["pass", "fail"])),
})
export type AiEvaluatorInput = Schema.Schema.Type<typeof AiEvaluatorInput>

const AiSessionEvaluationsInput = Schema.Struct({
	...EvaluationWindowInput.fields,
	sessionId: Schema.String.check(Schema.isMinLength(1)),
	traceIds: Schema.Array(Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(AI_EVALUATION_SESSION_MAX_TRACES),
	),
})
export type AiSessionEvaluationsInput = Schema.Schema.Type<typeof AiSessionEvaluationsInput>

/** Every evaluator that wrote a score in the window, with its measures. */
export const listAiEvaluators = Effect.fn("AiEvaluations.list")(function* ({
	data,
}: {
	data: EvaluationWindowInput
}) {
	const input = yield* decodeInput(EvaluationWindowInput, data, "aiEvaluatorsList")
	return yield* runWarehouseQuery("aiEvaluatorsList", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.aiEvaluationsInternal.list({
				payload: new ListAiEvaluatorsRequest({ startTime: input.startTime, endTime: input.endTime }),
			})
		}),
	)
})

/** One evaluator: summary, series, service breakdown and its latest scores. */
export const getAiEvaluator = Effect.fn("AiEvaluations.evaluator")(function* ({
	data,
}: {
	data: AiEvaluatorInput
}) {
	const input = yield* decodeInput(AiEvaluatorInput, data, "aiEvaluator")
	return yield* runWarehouseQuery("aiEvaluator", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.aiEvaluationsInternal.evaluator({
				payload: new GetAiEvaluatorRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					name: input.name,
					bucketSeconds: input.bucketSeconds,
					...(input.verdict !== undefined && { verdict: input.verdict }),
				}),
			})
		}),
	)
})

/** The scores written against one session's traces. */
export const getAiSessionEvaluations = Effect.fn("AiEvaluations.session")(function* ({
	data,
}: {
	data: AiSessionEvaluationsInput
}) {
	const input = yield* decodeInput(AiSessionEvaluationsInput, data, "aiSessionEvaluations")
	return yield* runWarehouseQuery("aiSessionEvaluations", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.aiEvaluationsInternal.session({
				payload: new GetAiSessionEvaluationsRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					sessionId: input.sessionId,
					traceIds: input.traceIds,
				}),
			})
		}),
	)
})
