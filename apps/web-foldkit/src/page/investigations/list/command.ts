import { Clock, Duration, Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { loadSignalPresences } from "../../kit/signal-presence"
import { Message } from "./message"

export const PAGE_SIZE = 100

export const ReadInvestigationsClock = Command.define("ReadInvestigationsClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

const fetchPage = (cursor: string | undefined) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const page = yield* client.investigations.list({
			query: cursor === undefined ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor },
		})
		return { data: page.data, hasMore: page.has_more, nextCursor: page.next_cursor }
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

export const FetchInvestigations = Command.define("FetchInvestigations", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchFirstPage],
	execute: ({ key }) => Effect.map(fetchPage(undefined), (result) => Message.CompletedFetchFirstPage({ key, result })),
})

export const FetchMoreInvestigations = Command.define("FetchMoreInvestigations", {
	args: { key: Schema.String, cursor: Schema.String },
	messages: [Message.CompletedFetchMorePage],
	execute: ({ key, cursor }) =>
		Effect.map(fetchPage(cursor), (result) => Message.CompletedFetchMorePage({ key, cursor, result })),
})

/** `aiTriage.getSettings`: whether the daily budget has paused automatic triage. */
export const FetchTriageBudget = Command.define("FetchTriageBudget", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchBudget],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const settings = yield* client.aiTriage.getSettings()
			return {
				enabled: settings.enabled,
				ordinaryPaused: settings.ordinaryPaused,
				priorityPaused: settings.priorityPaused,
				pausedDimension: settings.pausedDimension,
				resumesAt: settings.resumesAt,
			}
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchBudget({ key, result })),
		),
})

/** `investigations.create` with a freeform subject: the investigate bar and the hero. */
export const CreateQuestion = Command.define("CreateInvestigationQuestion", {
	args: { title: Schema.String },
	messages: [Message.CompletedCreate],
	execute: ({ title }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const created = yield* client.investigations.create({
				payload: {
					subject: { type: "freeform", title, prompt: title, context_refs: [] },
					snapshot: {
						title,
						scope: null,
						status: "open",
						severity: null,
						facts: [],
						references: [],
						incidentStartedAt: null,
						incidentEndedAt: null,
					},
				},
			})
			return String(created.id)
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedCreate({ result })),
		),
})

export const WaitInvestigationsSearch = Command.define("WaitInvestigationsSearch", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ generation })),
})

export const LoadInvestigationsPresence = Command.define("LoadInvestigationsPresence", {
	messages: [Message.CompletedLoadSignalPresence],
	execute: Effect.map(loadSignalPresences, (result) => Message.CompletedLoadSignalPresence({ result })),
})

/** The first-run hero is on screen: `useSignalPresence` mounts with it. */
export const MountHero = Mount.define("MountInvestigationsHero", {
	messages: [Message.PaintedHero],
	execute: () =>
		Effect.callback<ReturnType<typeof Message.PaintedHero>>((resume) => {
			const handle = requestAnimationFrame(() => requestAnimationFrame(() => resume(Effect.succeed(Message.PaintedHero()))))
			return Effect.sync(() => cancelAnimationFrame(handle))
		}),
})
