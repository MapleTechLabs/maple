import { Clock, DateTime, Effect, Option } from "effect"
import { IdleTtl } from "../../data/idle-ttl"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { readThrough } from "../../data/read-cache"
import { requestKey } from "@maple/views/data/request-key"
import { type SignalPresence, SignalPresences, UNKNOWN_PRESENCE } from "@maple/views/data/signal-presence"
import { MapleApiV2Client } from "../../platform/api-clients"

// Signal presence over `telemetrySignalsAtom`.

/** `GET /v2/telemetry_signals`, by signal kind. */
const fetchSignalPresences = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	const response = yield* client.telemetrySignals.retrieve()
	return Object.fromEntries(
		response.signals.map((entry): readonly [string, SignalPresence] => [
			entry.signal,
			entry.status === "unknown"
				? UNKNOWN_PRESENCE
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
