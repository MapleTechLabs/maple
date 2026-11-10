import { readClock } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readGrants } from "../../../data/session-tenant"
import { listPageSummaries } from "../shared/commands"
import { Message } from "./message"

export const ReadListClock = readClock("ReadStatusPagesClock", Message.ReadClock)

export const FetchListSession = Command.define("FetchStatusPagesSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readGrants, (grants) => Message.CompletedFetchSession({ orgId, grants })),
})

export const FetchStatusPages = Command.define("FetchStatusPageSummaries", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchPages],
	execute: ({ key }) =>
		listPageSummaries.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPages({ key, result })),
		),
})
