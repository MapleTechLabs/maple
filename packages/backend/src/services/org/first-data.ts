import type { OrgId } from "@maple/domain/http"
import { Array as Arr, Order } from "effect"
import type { ProductEventInput } from "@maple/backend/services/product-events/ProductEventsService"
import type { SignalPresenceReport } from "./SignalPresenceService"

/** The signals that count as an org's first data: backend telemetry, not sessions or product events. */
const FIRST_DATA_SIGNALS: ReadonlyArray<string> = ["traces", "logs", "metrics"]

/** What the warehouse showed when an org's first data was found. */
export interface FirstDataSeen {
	/** The first-data signals present, earliest first. */
	readonly signals: ReadonlyArray<string>
	/** Earliest row among them, when the warehouse reported one. */
	readonly firstSeenMs: number | null
}

const byFirstSeen = Order.mapInput(
	Order.Number,
	(entry: { readonly firstSeen: number | null }) => entry.firstSeen ?? Number.MAX_SAFE_INTEGER,
)

/** The org's first data in a presence report, or `undefined` when it has none yet. */
export const firstDataSeen = (report: SignalPresenceReport): FirstDataSeen | undefined => {
	const present = Arr.sort(
		Arr.filter(
			report.signals,
			(signal) => signal.status === "present" && FIRST_DATA_SIGNALS.includes(signal.signal),
		),
		byFirstSeen,
	)
	const first = present[0]
	if (first === undefined) return undefined
	return { signals: Arr.map(present, (signal) => signal.signal), firstSeenMs: first.firstSeen }
}

/**
 * `first_data_received`, timed at the earliest row so funnel timing reflects when data landed,
 * not when it was noticed. `first_signal` names the signal that arrived first.
 */
export const firstDataReceivedEvent = (
	orgId: OrgId,
	firstData: FirstDataSeen,
	nowMs: number,
): ProductEventInput => ({
	name: "first_data_received",
	groupId: orgId,
	timestamp: firstData.firstSeenMs ?? nowMs,
	attributes: {
		signals: Arr.join(firstData.signals, ","),
		...(firstData.signals[0] === undefined ? undefined : { first_signal: firstData.signals[0] }),
	},
})
