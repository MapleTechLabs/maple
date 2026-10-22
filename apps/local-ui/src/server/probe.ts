import { CH } from "@maple/query-engine"
import { probeLocalStatus } from "../lib/local-status"
import { parseClickHouseDateTime, toClickHouseDateTime } from "../lib/time"
import { Clock, Effect, Option } from "effect"
import type { HttpClient } from "effect/http"
import { localParams, queryRows } from "../data/local-query"
import { LEGACY_WINDOW_MS, PROBE_TIMEOUT_MS, ProbeOutcome } from "./state"

// The server status probe as one Effect.

/** Legacy binaries (no `/local/status`): the newest span or log in the last ten minutes. */
const legacyLastSeen = (apiBase: string) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const compiled = CH.compileUnion(
			CH.orgTelemetryPulseQuery(),
			localParams({
				startTime: toClickHouseDateTime(now - LEGACY_WINDOW_MS),
				endTime: toClickHouseDateTime(now + 60 * 1000),
			}),
		)
		const rows = yield* queryRows(compiled, apiBase)
		return rows
			.filter((row) => row.count > 0)
			.reduce<number | null>((latest, row) => {
				const ms = parseClickHouseDateTime(row.lastSeen)
				return ms !== null && (latest === null || ms > latest) ? ms : latest
			}, null)
	}).pipe(
		Effect.timeoutOption(PROBE_TIMEOUT_MS),
		Effect.orElseSucceed(() => Option.none<number | null>()),
	)

export const probeServer = (apiBase: string): Effect.Effect<ProbeOutcome, never, HttpClient.HttpClient> =>
	Effect.flatMap(
		probeLocalStatus(apiBase, PROBE_TIMEOUT_MS),
		(probe): Effect.Effect<ProbeOutcome, never, HttpClient.HttpClient> => {
			if (probe._tag === "Ok")
				return Effect.succeed(ProbeOutcome.Ok({ lastIngestAtMs: probe.status.lastIngestAtMs }))
			if (probe._tag === "Legacy")
				return Effect.map(legacyLastSeen(apiBase), (maybeLastSeen) =>
					ProbeOutcome.Legacy({ maybeLastSeen }),
				)
			if (probe._tag === "Busy") return Effect.succeed(ProbeOutcome.Busy())
			if (probe._tag === "Refused") return Effect.succeed(ProbeOutcome.Refused())
			return Effect.succeed(ProbeOutcome.Rejected({ status: probe.status, detail: probe.detail }))
		},
	)
