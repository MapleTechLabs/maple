import { isSessionLive, sessionDurationMs, type SessionLiveness } from "@maple/ui/lib/replay-format"
import { parseClickHouseDateTime, type WarehouseTime } from "./time"

/** The session fields that decide live-ness, as the local queries decode them. */
export interface LocalSessionTimes {
	readonly status: string
	readonly startTime: WarehouseTime
	readonly lastActivityAt: WarehouseTime
	readonly durationMs?: number | null
}

const isoOrNull = (value: WarehouseTime): string | null => {
	const ms = parseClickHouseDateTime(value)
	return ms === null ? null : new Date(ms).toISOString()
}

const toLiveness = (session: LocalSessionTimes): SessionLiveness => ({
	status: session.status,
	lastActivityAt: isoOrNull(session.lastActivityAt),
	startTime: isoOrNull(session.startTime) ?? "",
	durationMs: session.durationMs,
})

/**
 * Live by the shared heartbeat window, not `status === "active"`: a tab that dies
 * never writes its end row, so status alone keeps it "active" for its whole retention.
 */
export function isLocalSessionLive(session: LocalSessionTimes, nowMs = Date.now()): boolean {
	return isSessionLive(toLiveness(session), nowMs)
}

/** Stored duration, or start to last heartbeat for sessions that never wrote an end row. */
export function localSessionDurationMs(session: LocalSessionTimes): number | null {
	return sessionDurationMs(toLiveness(session))
}
