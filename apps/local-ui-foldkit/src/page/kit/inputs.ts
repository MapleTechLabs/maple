import type { Option } from "effect"
import type { SignalPresence, TelemetrySignal } from "../../data/signal-presence"
import type { PageContext } from "../contract"

/** What a page view reads from the root besides its own Model. */
export type PageViewInputs = Readonly<{
	context: PageContext
	/** `useSignalPresence(signal)`: none while unknown (loading or unreadable). */
	presenceOf: (signal: TelemetrySignal) => Option.Option<SignalPresence>
	/** The clock at the presence read, for "last received 3m ago". */
	presenceNowMs: number
	/** The root's latest clock read (each server probe): legacy's per-render `Date.now()` for relative times. */
	clockMs: number
	/** `useNewDataSince(sinceMs)`: telemetry arrived after a list loaded. */
	hasNewDataSince: (sinceMs: number) => boolean
}>
