import { getAiEvaluator } from "@maple/web-data/warehouse/ai-evaluations"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, settleTo } from "@maple/views/data/load-failure"
import * as Frame from "../../kit/time-frame"
import { EvaluatorDetail } from "./model"

export const Message = defineMessageUnion({
	CompletedFetchDetail: { key: Schema.String, result: Schema.Result(EvaluatorDetail, LoadFailure) },
	ClickedRetry: {},
	ToggledFailingOnly: {},
	GotFrameMessage: { message: Frame.Message },
})
export type Message = typeof Message.Type

export const DetailInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	name: Schema.String,
	bucketSeconds: Schema.Number,
	verdict: Schema.optional(Schema.Literal("fail")),
})
export type DetailInput = typeof DetailInput.Type

export const FetchDetail = Command.define("FetchAgentEvaluator", {
	args: { key: Schema.String, input: DetailInput },
	messages: [Message.CompletedFetchDetail],
	execute: ({ key, input }) =>
		getAiEvaluator({ data: input }).pipe(
			Effect.map((response): EvaluatorDetail => ({
				...(response.summary !== undefined && { summary: response.summary }),
				series: response.series,
				breakdown: response.breakdown,
				scores: response.scores,
			})),
			settleTo((result) => Message.CompletedFetchDetail({ key, result })),
		),
})
