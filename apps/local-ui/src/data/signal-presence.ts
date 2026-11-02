import { CH } from "@maple/query-engine"
import { boundsForRange, parseClickHouseDateTime, snapToMinute, WIDEST_RANGE } from "../lib/time"
import { Clock, Effect, Schema } from "effect"
import type { HttpClient } from "effect/http"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { type SignalPresence, SignalPresences } from "@maple/views/data/signal-presence"
import { localParams, queryRows } from "./local-query"

// Signal presence: whether the store holds a signal anywhere in the widest range.

export const PresenceResult = Schema.Struct({
	signals: SignalPresences,
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
			signals: Object.fromEntries(
				rows.map((row): readonly [string, SignalPresence] => [
					row.signal,
					row.count > 0
						? { status: "present", lastSeenMs: parseClickHouseDateTime(row.lastSeen) }
						: { status: "absent", lastSeenMs: null },
				]),
			),
		}
	})
