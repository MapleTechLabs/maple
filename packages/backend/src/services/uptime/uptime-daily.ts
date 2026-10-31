import * as Orm from "@maple-dev/effect-orm/database"
import type { MapleDb } from "@maple/db/client"
import type { OrgId, UptimeMonitorId } from "@maple/domain/primitives"
import { utcDay } from "@maple/domain/status-page"
import { Effect } from "effect"
import { msToSqlTimestamp } from "@maple/backend/platform/time"

/** One monitor's checks on one UTC day, as a batch adds them to `uptime_monitor_daily`. */
export interface UptimeDailyCount {
	readonly day: string
	readonly checks: number
	readonly failures: number
	readonly downChecks: number
	readonly lastCheckAt: number
}

interface CheckToCount {
	readonly at: number
	readonly ok: boolean
	/** The monitor's status after the check is down. */
	readonly down: boolean
}

/** One check as its day's counts. */
export const countOne = (check: CheckToCount): UptimeDailyCount => ({
	day: utcDay(check.at),
	checks: 1,
	failures: check.ok ? 0 : 1,
	downChecks: check.down ? 1 : 0,
	lastCheckAt: check.at,
})

/** Adds one check to its day's counts. */
export const countCheck = (
	counts: ReadonlyArray<UptimeDailyCount>,
	check: CheckToCount,
): ReadonlyArray<UptimeDailyCount> => {
	const one = countOne(check)
	return counts.some((count) => count.day === one.day)
		? counts.map((count) =>
				count.day === one.day
					? {
							day: one.day,
							checks: count.checks + one.checks,
							failures: count.failures + one.failures,
							downChecks: count.downChecks + one.downChecks,
							lastCheckAt: Math.max(count.lastCheckAt, one.lastCheckAt),
						}
					: count,
			)
		: [...counts, one]
}

/** Adds the counts to each (monitor, day) row in one statement. */
export const upsertDailyCounts = (
	db: MapleDb,
	rows: ReadonlyArray<{
		readonly monitorId: UptimeMonitorId
		readonly orgId: OrgId
		readonly count: UptimeDailyCount
	}>,
) => {
	if (rows.length === 0) return Effect.void
	const values = Orm.sql.join(
		rows.map(
			({ monitorId, orgId, count }) =>
				Orm.sql`(${monitorId}::text, ${count.day}::text, ${orgId}::text, ${count.checks}::int4, ${count.failures}::int4, ${count.downChecks}::int4, ${msToSqlTimestamp(count.lastCheckAt)}::timestamptz)`,
		),
		Orm.sql`, `,
	)
	return db.execute(Orm.sql`
		INSERT INTO uptime_monitor_daily (monitor_id, day, org_id, checks, failures, down_checks, last_check_at)
		VALUES ${values}
		ON CONFLICT (monitor_id, day) DO UPDATE SET
			checks = uptime_monitor_daily.checks + excluded.checks,
			failures = uptime_monitor_daily.failures + excluded.failures,
			down_checks = uptime_monitor_daily.down_checks + excluded.down_checks,
			last_check_at = greatest(uptime_monitor_daily.last_check_at, excluded.last_check_at)`)
}
