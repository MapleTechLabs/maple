import { readClock } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readGrants } from "../../../data/session-tenant"
import { fetchSourcesList, loadSourcesUsage, resumeSource } from "../kit/data"
import { Message } from "./message"

export const ReadSourcesClock = readClock("ReadSourcesClock", Message.ReadClock)

export const ReadSourcesGrants = Command.define("ReadSourcesGrants", {
	messages: [Message.CompletedReadGrants],
	execute: Effect.map(readGrants, (grants) => Message.CompletedReadGrants({ grants })),
})

export const FetchSourcesList = fetchSourcesList(Message.CompletedFetchList)

export const FetchSourcesUsage = Command.define("FetchSourcesUsage", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchUsage],
	execute: ({ key, refresh }) =>
		loadSourcesUsage(key, refresh).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchUsage({ key, result })),
		),
})

export const ResumeSource = resumeSource(Message.CompletedResume)
