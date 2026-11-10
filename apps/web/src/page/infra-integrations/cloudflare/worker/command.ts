import { resolveWindowCommand } from "../../../kit/time-frame"
import { reloadSpin } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { linkedCursorStream } from "@maple/views/charts/linked-cursor"
import {
	loadPlatform,
	loadReleases,
	loadStatus,
	loadUsage,
	loadWorkerDetail,
	loadWorkers,
	ReleasesInput,
	WindowInput,
	WorkerDetailInput,
} from "../data"
import { Message } from "./model"

export const ResolveWindow = resolveWindowCommand(
	"ResolveCloudflareWorkerWindow",
	Message.CompletedResolveWindow,
)

export const LoadStatus = Command.define("LoadCloudflareWorkerStatus", {
	args: { key: Schema.String, refresh: Schema.Boolean },
	messages: [Message.CompletedLoadStatus],
	execute: ({ key, refresh }) =>
		Effect.map(loadStatus(refresh), (result) => Message.CompletedLoadStatus({ key, result })),
})

export const LoadUsage = Command.define("LoadCloudflareWorkerUsage", {
	args: { key: Schema.String },
	messages: [Message.CompletedLoadUsage],
	execute: ({ key }) => Effect.map(loadUsage, (result) => Message.CompletedLoadUsage({ key, result })),
})

export const FetchDetail = Command.define("FetchCloudflareWorkerDetail", {
	args: { key: Schema.String, input: WorkerDetailInput },
	messages: [Message.CompletedFetchDetail],
	execute: ({ key, input }) =>
		Effect.map(loadWorkerDetail(input), (result) => Message.CompletedFetchDetail({ key, result })),
})

export const FetchWorkers = Command.define("FetchCloudflareWorkerRollups", {
	args: { key: Schema.String, input: WindowInput },
	messages: [Message.CompletedFetchWorkers],
	execute: ({ key, input }) =>
		Effect.map(loadWorkers(input), (result) => Message.CompletedFetchWorkers({ key, result })),
})

export const FetchPlatform = Command.define("FetchCloudflareWorkerPlatform", {
	args: { key: Schema.String, input: WindowInput },
	messages: [Message.CompletedFetchPlatform],
	execute: ({ key, input }) =>
		Effect.map(loadPlatform(input), (result) => Message.CompletedFetchPlatform({ key, result })),
})

export const FetchReleases = Command.define("FetchCloudflareWorkerReleases", {
	args: { key: Schema.String, input: ReleasesInput },
	messages: [Message.CompletedFetchReleases],
	execute: ({ key, input }) =>
		Effect.map(loadReleases(input), (result) => Message.CompletedFetchReleases({ key, result })),
})

export const CompleteReloadSpin = reloadSpin(
	"CompleteCloudflareWorkerReloadSpin",
	Message.CompletedReloadSpin,
)

/** `useLinkedCursor` on the strips. */
export const MountLinkedCursor = Mount.defineStream("MountCloudflareWorkerLinkedCursor", {
	messages: [Message.AttachedLinkedCursor],
	execute: ({ element }) => linkedCursorStream(element, Message.AttachedLinkedCursor()),
})
