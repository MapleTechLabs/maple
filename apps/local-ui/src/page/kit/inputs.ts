import type { PresenceState, TelemetrySignalKind } from "@maple/views/data/signal-presence"
import type { PageContext } from "../contract"

/** What a page view reads from the root besides its own Model. */
export type PageViewInputs = Readonly<{
	context: PageContext
	/** `useSignalPresence(signal)`: `loading` until the read settles, `unknown` if it failed. */
	presenceOf: (signal: TelemetrySignalKind) => PresenceState
	/** The clock at the presence read, for "last received 3m ago". */
	presenceNowMs: number
	/** The root's latest clock read (each server probe): legacy's per-render `Date.now()` for relative times. */
	clockMs: number
	/** `useNewDataSince(sinceMs)`: telemetry arrived after a list loaded. */
	hasNewDataSince: (sinceMs: number) => boolean
}>
