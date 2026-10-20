import { DateTime, Effect, Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { MapleApiV2Client } from "../../platform/api-clients"

// Signal presence over `telemetrySignalsAtom`.

export const TelemetrySignalKind = Schema.Literals([
	"traces",
	"logs",
	"metrics",
	"sessions",
	"product_events",
])
export type TelemetrySignalKind = typeof TelemetrySignalKind.Type

/** One signal's presence; `unknown` covers loading and an unreadable warehouse alike. */
export const SignalPresence = Schema.Struct({
	status: Schema.Literals(["present", "absent", "unknown"]),
	lastSeenMs: Schema.NullOr(Schema.Number),
})
export type SignalPresence = typeof SignalPresence.Type

export const SignalPresences = Schema.Record(Schema.String, SignalPresence)
export const SignalPresenceData = AsyncData.Schema(SignalPresences, LoadFailure)
export type SignalPresenceData = AsyncData.AsyncData<typeof SignalPresences.Type, LoadFailure>

const UNKNOWN: SignalPresence = { status: "unknown", lastSeenMs: null }

/** `GET /v2/telemetry_signals`, by signal kind; a page's Command maps the Result into its Message. */
export const loadSignalPresences = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	const response = yield* client.telemetrySignals.retrieve()
	return Object.fromEntries(
		response.signals.map((entry): readonly [string, SignalPresence] => [
			entry.signal,
			entry.status === "unknown"
				? UNKNOWN
				: {
						status: entry.status,
						lastSeenMs:
							entry.last_seen === null
								? null
								: Option.getOrNull(
										Option.map(DateTime.make(entry.last_seen), DateTime.toEpochMillis),
									),
					},
		]),
	)
}).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** What the empty state knows: `unknown` until the presence has loaded. */
export const presenceOf = (data: SignalPresenceData, signal: TelemetrySignalKind): SignalPresence =>
	Option.match(AsyncData.getData(data), {
		onNone: () => UNKNOWN,
		onSome: (presences) => presences[signal] ?? UNKNOWN,
	})
