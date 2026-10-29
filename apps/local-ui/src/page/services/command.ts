import { Clock, Effect, Layer, Option, Schema } from "effect"
import { DEBOUNCE } from "../traces/command"
import { cachedAs, readCached, recordCached } from "../../data/cached"
import { ServicesDefinition } from "./definition"
import { fetchCatalog } from "./fetch"
import { Catalog } from "./model"
import { Message } from "./message"

export const ReadClock = ServicesDefinition.makeCommand("ReadServicesClock", {
	messages: [Message.CompletedReadClock],
	handler: function* () {
		return () => Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs }))
	},
})

export const ReadRefreshClock = ServicesDefinition.makeCommand("ReadServicesRefreshClock", {
	messages: [Message.CompletedReadRefreshClock],
	handler: function* () {
		return () => Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadRefreshClock({ nowMs }))
	},
})

/** One `useCatalog`: an env/ns slice (absent = unfiltered) over the window. */
export const FetchCatalog = ServicesDefinition.makeCommand("FetchLocalServiceCatalog", {
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
	handler: function* () {
		return ({ key, env, ns, startTime, endTime, apiBase, readsCache }) =>
			Effect.gen(function* () {
				const cacheKey = ["local", "services", "catalog", env, ns, `${startTime}/${endTime}`]
				const maybeCached = readsCache ? yield* readCached(cacheKey, cachedAs(Catalog)) : Option.none()
				if (Option.isSome(maybeCached)) return Message.FoundCachedCatalog({ key, cached: maybeCached.value })
				const catalog = yield* fetchCatalog(env ?? undefined, ns ?? undefined, { startTime, endTime }, apiBase)
				const fetchedAtMs = yield* Clock.currentTimeMillis
				yield* recordCached(cacheKey, catalog, fetchedAtMs)
				return Message.SucceededFetchCatalog({ key, catalog, fetchedAtMs })
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchCatalog({ key, failure }))))
	},
})

export const WaitSearchDebounce = ServicesDefinition.makeCommand("WaitServicesSearchDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	handler: function* () {
		return ({ version }) => Effect.as(Effect.sleep(DEBOUNCE), Message.ElapsedSearchDebounce({ version }))
	},
})

/** Every handler the page owns; HTTP and the result cache come from the application Layer. */
export const EffectsLayer = Layer.mergeAll(
	ReadClock.layer,
	ReadRefreshClock.layer,
	FetchCatalog.layer,
	WaitSearchDebounce.layer,
)

/** Any Command the page's update returns. */
export type ServicesCommand =
	| ReturnType<typeof ReadClock>
	| ReturnType<typeof ReadRefreshClock>
	| ReturnType<typeof FetchCatalog>
	| ReturnType<typeof WaitSearchDebounce>
