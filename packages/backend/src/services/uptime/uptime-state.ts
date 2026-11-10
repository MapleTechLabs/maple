// What the uptime services share about a monitor's state row: its persistence error, and the
// write a single duration-less check (a heartbeat ping, or a heartbeat found overdue) makes.

import type { MapleDb } from "@maple/db/client"
import { UptimeMonitorPersistenceError } from "@maple/domain/http"
import type { OrgId, UptimeMonitorId, UptimeMonitorStatus } from "@maple/primitives"
import { appendRecentCheck, type UptimeRecentCheck } from "@maple/domain/uptime"
import { Effect } from "effect"
import { bumpPagesForMonitors } from "@maple/backend/services/status-pages/outbox"
import { countOne, upsertDailyCounts } from "./uptime-daily"

/** `unknown -> UptimeMonitorPersistenceError`, keeping the raw cause. */
export const toUptimePersistenceError = (error: unknown) =>
	new UptimeMonitorPersistenceError({
		message: error instanceof Error ? error.message : "Uptime monitor persistence failed",
		cause: error,
	})

interface StateBefore {
	readonly status: UptimeMonitorStatus
	readonly consecutiveFailures: number
	readonly consecutiveSuccesses: number
	readonly statusChangedAt: number | null
	readonly recentJson: ReadonlyArray<UptimeRecentCheck>
}

/** The state fields one check without a duration writes over `before`. */
export const heartbeatCheckState = (before: StateBefore, at: number, ok: boolean, error: string | null) => {
	const status: UptimeMonitorStatus = ok ? "up" : "down"
	return {
		status,
		consecutiveFailures: ok ? 0 : before.consecutiveFailures + 1,
		consecutiveSuccesses: ok ? before.consecutiveSuccesses + 1 : 0,
		statusChangedAt: status === before.status ? before.statusChangedAt : at,
		lastCheckJson: { at, ok, durationMs: null, statusCode: null, error, traceId: null },
		recentJson: appendRecentCheck(before.recentJson, { at, ok, durationMs: null }),
		updatedAt: at,
	}
}

/** In the state write's transaction, once it landed: the check counts on its day, and a flip republishes pages. */
export const recordHeartbeatCheck = (
	db: MapleDb,
	orgId: OrgId,
	monitorId: UptimeMonitorId,
	before: UptimeMonitorStatus,
	check: { readonly at: number; readonly ok: boolean },
) =>
	Effect.gen(function* () {
		const after: UptimeMonitorStatus = check.ok ? "up" : "down"
		yield* upsertDailyCounts(db, [
			{ monitorId, orgId, count: countOne({ at: check.at, ok: check.ok, down: after === "down" }) },
		])
		if (after !== before) yield* bumpPagesForMonitors(db, orgId, [monitorId])
	})
