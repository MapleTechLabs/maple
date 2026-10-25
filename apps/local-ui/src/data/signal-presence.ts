import { CH } from "@maple/query-engine"
import { boundsForRange, parseClickHouseDateTime, snapToMinute, WIDEST_RANGE } from "../lib/time"
import { Array, Clock, Effect, Option, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { type LoadFailure, localParams, queryRows } from "./local-query"

// Signal presence: whether the store holds a signal anywhere in the
// widest range, so an empty list can tell "never connected" from "nothing in this window".

export const TelemetrySignal = Schema.Literals(["traces", "logs", "metrics", "sessions"])
export type TelemetrySignal = typeof TelemetrySignal.Type

export const SignalPresence = Schema.Struct({
	signal: Schema.String,
	status: Schema.Literals(["present", "absent"]),
	lastSeenMs: Schema.NullOr(Schema.Number),
})
export type SignalPresence = typeof SignalPresence.Type

export const PresenceResult = Schema.Struct({
	rows: Schema.Array(SignalPresence),
	/** The clock at the read, for "last received 3m ago". */
	nowMs: Schema.Number,
})
export type PresenceResult = typeof PresenceResult.Type

/** `staleTime: 60_000`: a read younger than this answers every empty state without a request. */
export const PRESENCE_STALE_MS = 60_000

export const fetchSignalPresence = (apiBase: string): Effect.Effect<PresenceResult, LoadFailure, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const nowMs = yield* Clock.currentTimeMillis
		const bounds = boundsForRange(WIDEST_RANGE, snapToMinute(nowMs))
		const rows = yield* queryRows(CH.compileUnion(CH.signalPresenceQuery(), localParams(bounds)), apiBase)
		return {
			nowMs,
			rows: rows.map(
				(row): SignalPresence =>
					row.count > 0
						? { signal: row.signal, status: "present", lastSeenMs: parseClickHouseDateTime(row.lastSeen) }
						: { signal: row.signal, status: "absent", lastSeenMs: null },
			),
		}
	})

/** `data?.get(signal) ?? UNKNOWN` (a Map keeps the last row): none while loading, failed or missing. */
export const presenceOf = (
	maybeResult: Option.Option<PresenceResult>,
	signal: TelemetrySignal,
): Option.Option<SignalPresence> =>
	Option.flatMap(maybeResult, (result) => Array.findLast(result.rows, (row) => row.signal === signal))
