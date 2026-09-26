import { useQuery } from "@tanstack/react-query"
import { CH } from "@maple/query-engine"
import { executeLocalCompiledQuery, localParams } from "@/lib/query"
import { boundsForRange, parseClickHouseDateTime, snapToMinute, WIDEST_RANGE } from "../lib/time"

export type TelemetrySignal = "traces" | "logs" | "metrics" | "sessions"

export interface SignalPresence {
	/**
	 * `unknown` covers loading and a failed read. Empty states must not advise
	 * in that case: telling someone to wire up what they already wired is worse
	 * than saying nothing.
	 */
	readonly status: "present" | "absent" | "unknown"
	readonly lastSeenMs: number | null
}

const UNKNOWN: SignalPresence = { status: "unknown", lastSeenMs: null }

/**
 * Whether the store holds a signal anywhere in the widest range, so an empty
 * list can tell "never connected" from "nothing in this window". Reads the
 * hourly usage rollup, so it is cheap.
 */
export function useSignalPresence(signal: TelemetrySignal): SignalPresence {
	const { data } = useQuery({
		queryKey: ["local", "signal-presence"],
		staleTime: 60_000,
		queryFn: async ({ signal: abort }) => {
			const bounds = boundsForRange(WIDEST_RANGE, snapToMinute(Date.now()))
			const rows = await executeLocalCompiledQuery(
				CH.compileUnion(CH.signalPresenceQuery(), localParams(bounds)),
				abort,
			)
			return new Map(
				rows.map((row): [string, SignalPresence] => [
					row.signal,
					Number(row.count) > 0
						? { status: "present", lastSeenMs: parseClickHouseDateTime(row.lastSeen) }
						: { status: "absent", lastSeenMs: null },
				]),
			)
		},
	})
	return data?.get(signal) ?? UNKNOWN
}
