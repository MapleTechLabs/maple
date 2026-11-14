import { readClock } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { listPageSummaries } from "../shared/commands"
import { Message } from "./message"
import { fetchSessionGrants } from "../../kit/session-grants"

export const ReadListClock = readClock("ReadStatusPagesClock", Message.ReadClock)

export const FetchListSession = fetchSessionGrants("FetchStatusPagesSession", Message.CompletedFetchSession)

export const FetchStatusPages = Command.define("FetchStatusPageSummaries", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchPages],
	execute: ({ key }) =>
		listPageSummaries.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPages({ key, result })),
		),
})
