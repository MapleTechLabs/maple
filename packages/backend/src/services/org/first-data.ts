import type { OrgId } from "@maple/domain/http"
import { Array as Arr, Duration, Order } from "effect"
import type { ProductEventInput } from "@maple/backend/services/product-events/ProductEventsService"
import type { SignalPresenceReport } from "./SignalPresenceService"

/** The signals that count as an org's first data: backend telemetry, not sessions or product events. */
const FIRST_DATA_SIGNALS: ReadonlyArray<string> = ["traces", "logs", "metrics"]

/** Ingest refuses product events backdated past 30 days; stay a day inside that. */
const MAX_BACKDATE = Duration.days(29)
/** Presence rows are hourly, so a first row within an hour of the window start may predate it. */
const HOUR_MS = 3_600_000

/** What the warehouse showed when an org's first data was found. */
export interface FirstDataSeen {
	/** The first-data signals present, earliest first. */
	readonly signals: ReadonlyArray<string>
	/** Start of the hour of the earliest row among them, when the warehouse reported one. */
	readonly firstSeenMs: number | null
	/** Start of the presence window the report read. */
	readonly windowStartMs: number
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
	return {
		signals: Arr.map(present, (signal) => signal.signal),
		firstSeenMs: first.firstSeen,
		windowStartMs: report.windowStart,
	}
}

/**
 * When the first data landed, as far as the event can say. The presence hour is floored, so it
 * is lifted to the org's creation (an event before signup breaks funnel order). Data that may
 * predate the window, or a time ingest would refuse as too old, falls back to now.
 */
export const firstDataTimestamp = (
	firstData: FirstDataSeen,
	orgCreatedAtMs: number | null,
	nowMs: number,
): number => {
	const seen = firstData.firstSeenMs
	if (seen === null || seen < firstData.windowStartMs + HOUR_MS) return nowMs
	const lifted = Math.min(Math.max(seen, orgCreatedAtMs ?? seen), nowMs)
	return lifted < nowMs - Duration.toMillis(MAX_BACKDATE) ? nowMs : lifted
}

/**
 * `first_data_received` for the org, attributed to the person who set it up so person-keyed
 * funnels count it. `first_signal` names the signal that arrived first.
 */
export const firstDataReceivedEvent = (input: {
	readonly orgId: OrgId
	readonly userId: string | null
	readonly firstData: FirstDataSeen
	readonly orgCreatedAtMs: number | null
	readonly nowMs: number
}): ProductEventInput => ({
	name: "first_data_received",
	groupId: input.orgId,
	...(input.userId === null ? undefined : { userId: input.userId }),
	timestamp: firstDataTimestamp(input.firstData, input.orgCreatedAtMs, input.nowMs),
	attributes: {
		signals: Arr.join(input.firstData.signals, ","),
		...(input.firstData.signals[0] === undefined ? undefined : { first_signal: input.firstData.signals[0] }),
	},
})
