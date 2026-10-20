import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { loadSources } from "../kit/data"
import { Message } from "./message"

export const ReadSourcesClock = Command.define("ReadSourcesClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
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
