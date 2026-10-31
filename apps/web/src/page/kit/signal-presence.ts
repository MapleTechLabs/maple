import { Clock, DateTime, Effect, Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import { IdleTtl } from "../../data/idle-ttl"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { readThrough } from "../../data/read-cache"
import { requestKey } from "../../data/request-key"
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

/** `GET /v2/telemetry_signals`, by signal kind. */
const fetchSignalPresences = Effect.gen(function* () {
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
})

/** Presence is reused within one bucket only: reads keep an idle TTL alive, so "absent" must expire anyway. */
const PRESENCE_BUCKET_MS = 30_000

/**
 * The org's presence through `ReadCache`: pages request it at init, so navigating between them
 * within a 30 s bucket reuses one read. A page's Command maps the Result into its Message.
 */
export const loadSignalPresences = (orgId: string) =>
	Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
		readThrough(
			{
				key: requestKey(orgId, "telemetrySignals", {
					bucket: Math.floor(nowMs / PRESENCE_BUCKET_MS),
				}),
				idleTtlMs: IdleTtl.signalPresence,
				schema: SignalPresences,
			},
			fetchSignalPresences,
		),
	).pipe(Effect.mapError(toLoadFailure), Effect.result)

/** Presence as an empty state reads it: `loading` until the read settles, `unknown` if it failed. */
export type PresenceState = SignalPresence | Readonly<{ status: "loading"; lastSeenMs: null }>

const LOADING: PresenceState = { status: "loading", lastSeenMs: null }

export const presenceOf = (data: SignalPresenceData, signal: TelemetrySignalKind): PresenceState =>
	Option.match(AsyncData.getData(data), {
		onNone: () => (AsyncData.isFailure(data) ? UNKNOWN : LOADING),
		onSome: (presences) => presences[signal] ?? UNKNOWN,
	})
