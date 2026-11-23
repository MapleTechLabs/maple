import { listAiEvaluators } from "@maple/web-data/warehouse/ai-evaluations"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, settleTo } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as Frame from "../../kit/time-frame"
import { Evaluators } from "./model"

export const Message = defineMessageUnion({
	CompletedFetchEvaluators: { key: Schema.String, result: Schema.Result(Evaluators, LoadFailure) },
	ClickedRetry: {},
	GotFrameMessage: { message: Frame.Message },
})
export type Message = typeof Message.Type

export const FetchEvaluators = Command.define("FetchAgentEvaluators", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchEvaluators],
	execute: ({ key, window }) =>
		listAiEvaluators({ data: { startTime: window.startTime, endTime: window.endTime } }).pipe(
			Effect.map((response) => response.evaluators),
			settleTo((result) => Message.CompletedFetchEvaluators({ key, result })),
		),
})
