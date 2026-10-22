import { Clock, Effect, Option, Schema } from "effect"
import { Command } from "foldkit"
import { DEBOUNCE } from "../traces/command"
import { cachedAs, readCached, recordCached } from "../../data/cached"
import { fetchCatalog } from "./fetch"
import { Catalog } from "./model"
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
		readsCache: Schema.Boolean,
	},
	messages: [Message.SucceededFetchCatalog, Message.FailedFetchCatalog, Message.FoundCachedCatalog],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, env, ns, startTime, endTime, apiBase, readsCache }) =>
		Effect.gen(function* () {
			const cacheKey = ["local", "services", "catalog", env, ns, `${startTime}/${endTime}`]
			const maybeCached = readsCache ? yield* readCached(cacheKey, cachedAs(Catalog)) : Option.none()
			if (Option.isSome(maybeCached)) return Message.FoundCachedCatalog({ key, cached: maybeCached.value })
			const catalog = yield* fetchCatalog(env ?? undefined, ns ?? undefined, { startTime, endTime }, apiBase)
			const fetchedAtMs = yield* Clock.currentTimeMillis
			yield* recordCached(cacheKey, catalog, fetchedAtMs)
			return Message.SucceededFetchCatalog({ key, catalog, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchCatalog({ key, failure })))),
})

export const WaitSearchDebounce = Command.define("WaitServicesSearchDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ version }) => Effect.as(Effect.sleep(DEBOUNCE), Message.ElapsedSearchDebounce({ version })),
})
