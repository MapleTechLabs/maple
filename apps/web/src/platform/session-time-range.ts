import { BrowserKeyValueStore } from "@effect/platform-browser"
import { Effect, Option, Schema } from "effect"
import { KeyValueStore } from "effect/persistence"
import { SessionTimeRange } from "../route/session-time-range"

/** `sessionTimeRangeAtomFor(orgId)`: an `Atom.kvs` entry in sessionStorage, JSON per its schema. */
const keyOf = (orgId: string) => `maple.time-range.session.${orgId}`

const codec = Schema.fromJsonString(SessionTimeRange)
const decode = Schema.decodeUnknownOption(codec)
const encode = Schema.encodeSync(codec)

// oxlint-disable-next-line effecttsgo/strict-effect-provide
const withSessionStorage = Effect.provide(BrowserKeyValueStore.layerSessionStorage)

/** The window remembered for the org in this tab; nothing (`{}`) when unset or unreadable. */
export const readSessionTimeRange = (orgId: string): Effect.Effect<SessionTimeRange> =>
	Effect.gen(function* () {
		const store = yield* KeyValueStore.KeyValueStore
		const raw = yield* store.get(keyOf(orgId))
		return Option.getOrElse(Option.flatMap(Option.fromNullishOr(raw), decode), () => ({}))
	}).pipe(withSessionStorage, Effect.orElseSucceed(() => ({})))

/** Storage failures are ignored: the window simply does not carry over. */
export const writeSessionTimeRange = (orgId: string, value: SessionTimeRange): Effect.Effect<void> =>
	Effect.gen(function* () {
		const store = yield* KeyValueStore.KeyValueStore
		yield* store.set(keyOf(orgId), encode(value))
	}).pipe(withSessionStorage, Effect.ignore)
