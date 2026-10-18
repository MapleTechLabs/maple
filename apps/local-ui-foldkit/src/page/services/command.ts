import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { DEBOUNCE } from "../traces/command"
import { fetchCatalog } from "./fetch"
import { Message } from "./message"

export const ReadClock = Command.define("ReadServicesClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

export const ReadRefreshClock = Command.define("ReadServicesRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs })),
})

/** One `useCatalog`: an env/ns slice (absent = unfiltered) over the window. */
export const FetchCatalog = Command.define("FetchLocalServiceCatalog", {
	args: {
		key: Schema.String,
		env: Schema.NullOr(Schema.String),
		ns: Schema.NullOr(Schema.String),
		startTime: Schema.String,
		endTime: Schema.String,
		apiBase: Schema.String,
	},
	messages: [Message.SucceededFetchCatalog, Message.FailedFetchCatalog],
	execute: ({ key, env, ns, startTime, endTime, apiBase }) =>
		Effect.gen(function* () {
			const catalog = yield* fetchCatalog(env ?? undefined, ns ?? undefined, { startTime, endTime }, apiBase)
			const fetchedAtMs = yield* Clock.currentTimeMillis
			return Message.SucceededFetchCatalog({ key, catalog, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchCatalog({ key, failure })))),
})

export const WaitSearchDebounce = Command.define("WaitServicesSearchDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ version }) => Effect.as(Effect.sleep(DEBOUNCE), Message.ElapsedSearchDebounce({ version })),
})
