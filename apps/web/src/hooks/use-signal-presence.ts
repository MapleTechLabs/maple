import { Result, useAtomValue } from "@/lib/effect-atom"
import { telemetrySignalsAtom } from "@/lib/services/atoms/signal-atoms"

/** The signal kinds a view can be empty for. Mirrors the v2 wire contract. */
export type TelemetrySignalKind = "traces" | "logs" | "metrics" | "sessions" | "product_events"

export interface SignalPresence {
	/**
	 * `unknown` covers both "still loading" and "the warehouse could not be read". Callers must treat
	 * it as "do not advise" in both cases: guessing during the load flashes "you haven't set this up"
	 * at someone who has, which is the worst thing an empty state can say.
	 */
	readonly status: "present" | "absent" | "unknown"
	/** Epoch ms of the most recent event, when the signal is present. */
	readonly lastSeen: number | null
}

const UNKNOWN: SignalPresence = { status: "unknown", lastSeen: null }

/**
 * Whether this org has sent a given signal recently, for empty states that need to tell "nothing is
 * wired up" apart from "nothing happened in this window".
 */
export function useSignalPresence(signal: TelemetrySignalKind): SignalPresence {
	const result = useAtomValue(telemetrySignalsAtom)
	if (!Result.isSuccess(result)) return UNKNOWN

	const entry = result.value.signals.find((candidate) => candidate.signal === signal)
	if (entry === undefined || entry.status === "unknown") return UNKNOWN

	return {
		status: entry.status,
		lastSeen: entry.last_seen === null ? null : Date.parse(entry.last_seen),
	}
}
