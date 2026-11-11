import { StatusPageId } from "@maple/domain"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { viewPage } from "../shared/commands"
import { Message } from "./message"

export const FetchView = Command.define("FetchStatusPageView", {
	args: { key: Schema.String, pageId: StatusPageId },
	messages: [Message.CompletedFetchView],
	execute: ({ key, pageId }) =>
		viewPage(pageId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchView({ key, result })),
		),
})
