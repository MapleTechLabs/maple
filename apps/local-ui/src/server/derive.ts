import { Option } from "effect"
import { MISSES_BEFORE_DOWN, POLL_MS, ProbeOutcome, RECHECK_MS, type Rejection, type ServerState } from "./state"

/** `probe` in use-local-server-status.ts: the next state from the previous one and an outcome. */
export const nextServerState = (
	maybePrevious: Option.Option<ServerState>,
	outcome: ProbeOutcome,
	checkedAtMs: number,
): ServerState => {
	const previous = Option.getOrNull(maybePrevious)
	const base = {
		misses: 0,
		lastIngestAtMs: previous?.lastIngestAtMs ?? null,
		legacy: previous?.legacy ?? false,
		rejection: null,
		checkedAtMs,
		hasConnected: previous?.hasConnected ?? false,
	}
	return ProbeOutcome.match(outcome, {
		Ok: ({ lastIngestAtMs }): ServerState => ({
			...base,
			reachability: "connected",
			lastIngestAtMs,
			legacy: false,
			hasConnected: true,
		}),
		Legacy: ({ maybeLastSeen }): ServerState =>
			Option.match(maybeLastSeen, {
				onNone: (): ServerState => ({ ...base, reachability: "busy", legacy: true, hasConnected: true }),
				onSome: (lastIngestAtMs): ServerState => ({
					...base,
					reachability: "connected",
					lastIngestAtMs,
					legacy: true,
					hasConnected: true,
				}),
			}),
		Busy: (): ServerState => ({ ...base, reachability: "busy", hasConnected: true }),
		Refused: (): ServerState => ({ ...base, reachability: "refused", misses: (previous?.misses ?? 0) + 1 }),
		Rejected: ({ status, detail }): ServerState => ({
			...base,
			// A 4xx is this page being turned away; a 5xx is the server failing a request.
			reachability: status < 500 ? "rejected" : "failing",
			rejection: { status, detail },
			hasConnected: true,
		}),
	})
}

/** `refetchInterval`: recheck quickly after one refusal, else the regular poll. */
export const nextProbeDelayMs = (state: ServerState): number =>
	state.reachability === "refused" && state.misses < MISSES_BEFORE_DOWN ? RECHECK_MS : POLL_MS

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "rejected"

/** `useLocalConnection`: only a server that is really gone swaps the views out. */
export const connectionOf = (
	maybeState: Option.Option<ServerState>,
): { readonly status: ConnectionStatus; readonly rejection: Rejection | null } =>
	Option.match(maybeState, {
		onNone: () => ({ status: "connecting", rejection: null }),
		onSome: (state) => {
			if (state.reachability === "refused") {
				// One refused probe can be a restart in progress; two in a row is down.
				if (state.misses >= MISSES_BEFORE_DOWN) return { status: "disconnected", rejection: null }
				return { status: state.hasConnected ? "connected" : "connecting", rejection: null }
			}
			if (state.reachability === "rejected") return { status: "rejected", rejection: state.rejection }
			return { status: "connected", rejection: null }
		},
	})
