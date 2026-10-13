import { useQuery, type QueryFunctionContext } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { Option } from "effect"
import { tryPromise } from "@maple/ui/lib/try-sync"
import { executeLocalCompiledQuery, localParams } from "@/lib/query"
import { localApiBase } from "../lib/constants"
import { runStatusProbe } from "../lib/local-status"
import { parseClickHouseDateTime, toClickHouseDateTime } from "../lib/time"

const POLL_MS = 5_000
/** After one refused probe, look again quickly: two misses in a row mean "down". */
const RECHECK_MS = 1_000
/** chDB answers one request at a time, so a slow query holds the probe; past this it reads as busy. */
const PROBE_TIMEOUT_MS = 3_000
/** Consecutive refused probes before the app swaps to the "can't reach" screen. */
export const MISSES_BEFORE_DOWN = 2
/** Legacy binaries (no `/local/status`): newest span/log in this window stands in for arrival time. */
const LEGACY_WINDOW_MS = 10 * 60 * 1000

export type Reachability = "connected" | "busy" | "refused" | "rejected" | "failing"

export interface LocalServerState {
	readonly reachability: Reachability
	/** Consecutive probes that found nothing listening. */
	readonly misses: number
	/** When the server last accepted a non-empty OTLP batch of any signal (epoch ms). */
	readonly lastIngestAtMs: number | null
	/** True for a binary without `/local/status`, where the time above is the newest event time. */
	readonly legacy: boolean
	/** The refusal, for a 4xx/5xx answer. */
	readonly rejection: { readonly status: number; readonly detail: string } | null
	/** Epoch ms of this probe; changes every poll so relative labels stay fresh. */
	readonly checkedAtMs: number
	/** Whether any probe in this page's life reached the server. */
	readonly hasConnected: boolean
}

const STATUS_KEY = ["local", "server-status"] as const

async function legacyLastSeen(signal: AbortSignal): Promise<Option.Option<number | null>> {
	const now = Date.now()
	const compiled = CH.compileUnion(
		CH.orgTelemetryPulseQuery(),
		localParams({
			startTime: toClickHouseDateTime(now - LEGACY_WINDOW_MS),
			endTime: toClickHouseDateTime(now + 60 * 1000),
		}),
	)
	const rows = await tryPromise(() =>
		executeLocalCompiledQuery(compiled, AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])),
	)
	return Option.map(rows, (list) =>
		list
			.filter((row) => row.count > 0)
			.reduce<number | null>((latest, row) => {
				const ms = parseClickHouseDateTime(row.lastSeen)
				return ms !== null && (latest === null || ms > latest) ? ms : latest
			}, null),
	)
}

async function probe({ client, signal }: QueryFunctionContext<typeof STATUS_KEY>): Promise<LocalServerState> {
	const previous = client.getQueryData<LocalServerState>(STATUS_KEY)
	const result = await runStatusProbe(localApiBase(), PROBE_TIMEOUT_MS, signal)
	const base = {
		misses: 0,
		lastIngestAtMs: previous?.lastIngestAtMs ?? null,
		legacy: previous?.legacy ?? false,
		rejection: null,
		checkedAtMs: Date.now(),
		hasConnected: previous?.hasConnected ?? false,
	}
	switch (result._tag) {
		case "Ok":
			return {
				...base,
				reachability: "connected",
				lastIngestAtMs: result.status.lastIngestAtMs,
				legacy: false,
				hasConnected: true,
			}
		case "Legacy": {
			const lastSeen = await legacyLastSeen(signal)
			return Option.match(lastSeen, {
				onNone: (): LocalServerState => ({
					...base,
					reachability: "busy",
					legacy: true,
					hasConnected: true,
				}),
				onSome: (lastIngestAtMs): LocalServerState => ({
					...base,
					reachability: "connected",
					lastIngestAtMs,
					legacy: true,
					hasConnected: true,
				}),
			})
		}
		case "Busy":
			return { ...base, reachability: "busy", hasConnected: true }
		case "Refused":
			return { ...base, reachability: "refused", misses: (previous?.misses ?? 0) + 1 }
		case "Rejected":
			return {
				...base,
				// A 4xx is this page being turned away; a 5xx is the server failing a request.
				reachability: result.status < 500 ? "rejected" : "failing",
				rejection: { status: result.status, detail: result.detail },
				hasConnected: true,
			}
	}
}

/**
 * Polls the local server for reachability and the last-ingest time. Drives the
 * header status pill, the app-level connection gate, and the lists' "new data"
 * hint. React Query dedupes every caller onto one poll.
 */
export function useLocalServerStatus() {
	return useQuery({
		queryKey: STATUS_KEY,
		queryFn: probe,
		staleTime: 0,
		// The poll is the recovery loop; never stack retries on a down binary.
		retry: false,
		refetchInterval: (query) => {
			const data = query.state.data
			return data?.reachability === "refused" && data.misses < MISSES_BEFORE_DOWN ? RECHECK_MS : POLL_MS
		},
	})
}

/** True when telemetry arrived after `sinceMs` (a list's `dataUpdatedAt`). */
export function useNewDataSince(sinceMs: number): boolean {
	const { data } = useLocalServerStatus()
	const last = data?.lastIngestAtMs ?? null
	return sinceMs > 0 && last !== null && last > sinceMs
}
