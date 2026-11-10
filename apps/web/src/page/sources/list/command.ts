import { readClock } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readGrants } from "../../../data/session-tenant"
import { loadSources, loadSourcesUsage } from "../kit/data"
import { Message } from "./message"

export const ReadSourcesClock = readClock("ReadSourcesClock", Message.ReadClock)

export const ReadSourcesGrants = Command.define("ReadSourcesGrants", {
	messages: [Message.CompletedReadGrants],
	execute: Effect.map(readGrants, (grants) => Message.CompletedReadGrants({ grants })),
})

export const FetchSourcesList = Command.define("FetchSourcesList", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchList],
	execute: ({ key, refresh }) =>
		loadSources(key, refresh).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchList({ key, result })),
		),
})

export const FetchSourcesUsage = Command.define("FetchSourcesUsage", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchUsage],
	execute: ({ key, refresh }) =>
		loadSourcesUsage(key, refresh).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchUsage({ key, result })),
		),
})
