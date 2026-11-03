import { Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "./load-failure"

// Whether a signal ever reached the store, so an empty list can tell "never connected" from
// "nothing in this window". Each app reads it its own way and keeps the answer in its Model.

export const TelemetrySignalKind = Schema.Literals([
	"traces",
	"logs",
	"metrics",
	"sessions",
	"product_events",
])
export type TelemetrySignalKind = typeof TelemetrySignalKind.Type

/** One signal's presence; `unknown` covers an unreadable store. */
export const SignalPresence = Schema.Struct({
	status: Schema.Literals(["present", "absent", "unknown"]),
	lastSeenMs: Schema.NullOr(Schema.Number),
})
export type SignalPresence = typeof SignalPresence.Type

/** Presence by signal kind. */
export const SignalPresences = Schema.Record(Schema.String, SignalPresence)
export type SignalPresences = typeof SignalPresences.Type
export const SignalPresenceData = AsyncData.Schema(SignalPresences, LoadFailure)
export type SignalPresenceData = AsyncData.AsyncData<SignalPresences, LoadFailure>

export const UNKNOWN_PRESENCE: SignalPresence = { status: "unknown", lastSeenMs: null }

/** Presence as an empty state reads it: `loading` until the read settles, `unknown` if it failed. */
export type PresenceState = SignalPresence | Readonly<{ status: "loading"; lastSeenMs: null }>

const LOADING: PresenceState = { status: "loading", lastSeenMs: null }

export const presenceOf = <E>(
	data: AsyncData.AsyncData<SignalPresences, E>,
	signal: TelemetrySignalKind,
): PresenceState =>
	Option.match(AsyncData.getData(data), {
		onNone: () => (AsyncData.isFailure(data) ? UNKNOWN_PRESENCE : LOADING),
		onSome: (presences) => presences[signal] ?? UNKNOWN_PRESENCE,
	})
