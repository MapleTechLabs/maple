import { V2StatusPageCreateParams } from "@maple/domain/http/v2"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { createPage, listPageSummaries } from "../../shared/status-page-commands"
import { Message } from "./message"

export const FetchStatusPages = Command.define("FetchStatusPageSummaries", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchPages],
	execute: ({ key }) =>
		listPageSummaries.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPages({ key, result })),
		),
})

export const CreateStatusPage = Command.define("CreateStatusPage", {
	args: { payload: V2StatusPageCreateParams },
	messages: [Message.CompletedCreate],
	execute: ({ payload }) =>
		createPage(payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedCreate({ result })),
		),
})
