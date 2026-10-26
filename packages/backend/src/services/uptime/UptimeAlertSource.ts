import { randomUUID } from "node:crypto"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertRules, UptimeMonitorStates, UptimeMonitors } from "@maple/db/tables"
import { UNGROUPED_GROUP_KEY, UptimeMonitorPersistenceError } from "@maple/domain/http"
import {
	AlertRuleId,
	type OrgId,
	type UptimeMonitorId,
	type UptimeMonitorStatus,
	type UserId,
} from "@maple/domain/primitives"
import {
	appendRecentCheck,
	describeMissedHeartbeat,
	heartbeatDeadline,
	type UptimeMonitorConfig,
} from "@maple/domain/uptime"
import { Clock, Context, Effect, Layer, Option, Ref } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { uptimeRuleFields } from "@maple/backend/services/alerts/AlertRuleModel"

/** What an `uptime` alert rule observes for its monitor on one tick. */
export interface UptimeAlertObservation {
	/** The monitor's service when linked, so a down monitor is a cause in that service's health. */
	readonly groupKey: string
	readonly down: boolean
	/** The failing check's error, e.g. `Status 503, expected 2xx`; null while up. */
	readonly detail: string | null
}

/** The heartbeat fields the overdue check reads. */
export interface HeartbeatWatch {
	readonly config: UptimeMonitorConfig
	readonly enabled: boolean
	readonly status: UptimeMonitorStatus
	readonly statusChangedAt: number | null
	readonly lastPingAt: number | null
	readonly createdAt: number
}

/**
 * True when a heartbeat missed its schedule plus grace. Waiting starts at the last ping, or at
 * creation or resume for a `pending` monitor, so a resumed monitor gets a full period first.
 */
export const isHeartbeatOverdue = (monitor: HeartbeatWatch, nowMs: number): boolean => {
	if (monitor.config._tag !== "heartbeat" || !monitor.enabled) return false
	if (monitor.status !== "up" && monitor.status !== "pending") return false
	const waitingSince =
		monitor.status === "pending"
			? Math.max(monitor.lastPingAt ?? 0, monitor.statusChangedAt ?? 0, monitor.createdAt)
			: (monitor.lastPingAt ?? monitor.createdAt)
	return Option.exists(heartbeatDeadline(monitor.config, waitingSince), (deadline) => nowMs > deadline)
}

export interface UptimeAlertSourceApi {
	/**
	 * The monitor behind `ruleId` as one observation, marking an overdue heartbeat down first.
	 * `None` when no monitor owns the rule any more.
	 */
	readonly observe: (
		orgId: OrgId,
		ruleId: AlertRuleId,
		nowMs: number,
	) => Effect.Effect<Option.Option<UptimeAlertObservation>, UptimeMonitorPersistenceError>
	/**
	 * Gives enabled monitors created before backing rules existed their rule, at most
	 * {@link MAX_RULE_BACKFILL} per call. Idempotent; once a pass finds none it is a no-op.
	 */
	readonly backfillRules: Effect.Effect<number, UptimeMonitorPersistenceError>
}

const MAX_RULE_BACKFILL = 100

interface MonitorWithoutRule {
	readonly id: UptimeMonitorId
	readonly orgId: OrgId
	readonly name: string
	readonly serviceName: string | null
	readonly enabled: boolean
	readonly createdBy: UserId
}

const toPersistenceError = (error: unknown) =>
	new UptimeMonitorPersistenceError({
		message: error instanceof Error ? error.message : "Uptime monitor persistence failed",
		cause: error,
	})

/**
 * The alert evaluator's view of uptime monitors. Its own service, with only the database,
 * so the alerting worker does not take on the monitor service's billing and HTTP dependencies.
 */
export class UptimeAlertSource extends Context.Service<UptimeAlertSource, UptimeAlertSourceApi>()(
	"@maple/backend/services/uptime/UptimeAlertSource",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "UptimeAlertSource", toPersistenceError)

			const readMonitor = (orgId: OrgId, ruleId: AlertRuleId) =>
				dbExecute((db) =>
					db.run(
						PG.from(UptimeMonitors, "m")
							.innerJoin(UptimeMonitorStates, "s", (m, s) =>
								m.id.eq(s.monitorId).and(m.orgId.eq(s.orgId)),
							)
							.select(($) => ({
								id: $.id,
								configJson: $.configJson,
								serviceName: $.serviceName,
								enabled: $.enabled,
								createdAt: $.createdAt,
								status: $.s.status,
								consecutiveFailures: $.s.consecutiveFailures,
								statusChangedAt: $.s.statusChangedAt,
								lastCheckJson: $.s.lastCheckJson,
								recentJson: $.s.recentJson,
								lastPingAt: $.s.lastPingAt,
								stateUpdatedAt: $.s.updatedAt,
							}))
							.where(($) => [$.orgId.eq(orgId), $.alertRuleId.eq(ruleId)])
							.limit(1),
					),
				).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])))

			/** The monitor as its state row says it is: down with the failing check's error, or not. */
			const asStored = (row: {
				readonly serviceName: string | null
				readonly status: UptimeMonitorStatus
				readonly lastCheckJson: { readonly error: string | null } | null
			}): UptimeAlertObservation => {
				const down = row.status === "down"
				return {
					groupKey: row.serviceName ?? UNGROUPED_GROUP_KEY,
					down,
					detail: down ? (row.lastCheckJson?.error ?? "The check is failing") : null,
				}
			}

			const observe = Effect.fn("UptimeAlertSource.observe")(function* (
				orgId: OrgId,
				ruleId: AlertRuleId,
				nowMs: number,
			) {
				const read = yield* readMonitor(orgId, ruleId)
				if (Option.isNone(read)) return Option.none<UptimeAlertObservation>()
				const row = read.value
				const groupKey = row.serviceName ?? UNGROUPED_GROUP_KEY
				const watch = { ...row, config: row.configJson }
				if (!isHeartbeatOverdue(watch, nowMs)) return Option.some(asStored(row))
				// Fenced on the state read above: a ping or check landing in between wins.
				const error = describeMissedHeartbeat(row.lastPingAt, nowMs)
				const marked = yield* dbExecute((db) =>
					db.run(
						PG.update(UptimeMonitorStates)
							.set({
								status: "down",
								consecutiveFailures: row.consecutiveFailures + 1,
								consecutiveSuccesses: 0,
								statusChangedAt: nowMs,
								lastCheckJson: {
									at: nowMs,
									ok: false,
									durationMs: null,
									statusCode: null,
									error,
									traceId: null,
								},
								recentJson: appendRecentCheck(row.recentJson, {
									at: nowMs,
									ok: false,
									durationMs: null,
								}),
								updatedAt: nowMs,
							})
							.where(($) => [
								$.orgId.eq(orgId),
								$.monitorId.eq(row.id),
								$.status.eq(row.status),
								$.updatedAt.eq(row.stateUpdatedAt),
							])
							.returning("monitorId"),
					),
				)
				yield* Effect.annotateCurrentSpan({
					"maple.uptime.monitor_id": row.id,
					"maple.uptime.heartbeat_overdue": marked.length > 0,
				})
				if (marked.length > 0) return Option.some({ groupKey, down: true, detail: error })
				// A ping or failure landed between the read and the write: report what it left.
				return Option.map(yield* readMonitor(orgId, ruleId), asStored)
			})

			// Monitors only lose the race to a rule at creation before this shipped: once none are
			// missing, the check is skipped for the life of the process.
			const backfillSettled = yield* Ref.make(false)

			const backfillOne = (monitor: MonitorWithoutRule) =>
				dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// The org lock rule writes take; the re-read makes a repeat a no-op.
							yield* db.execute(
								Orm.sql`select pg_advisory_xact_lock(hashtext(${monitor.orgId}))`,
							)
							const still = yield* db.run(
								PG.from(UptimeMonitors)
									.select("id")
									.where(($) => [
										$.orgId.eq(monitor.orgId),
										$.id.eq(monitor.id),
										$.alertRuleId.isNull(),
									])
									.limit(1),
							)
							if (still.length === 0) return false
							const ruleId = AlertRuleId.make(randomUUID())
							const now = yield* Clock.currentTimeMillis
							yield* db.run(
								PG.insertInto(AlertRules).values({
									id: ruleId,
									orgId: monitor.orgId,
									...uptimeRuleFields({ ...monitor, destinationIds: [] }),
									lastScheduledAt: null,
									createdAt: now,
									updatedAt: now,
									createdBy: monitor.createdBy,
									updatedBy: monitor.createdBy,
								}),
							)
							yield* db.run(
								PG.update(UptimeMonitors)
									.set({ alertRuleId: ruleId })
									.where(($) => [$.orgId.eq(monitor.orgId), $.id.eq(monitor.id)]),
							)
							return true
						}),
					),
				)

			const backfillRules = Effect.gen(function* () {
				if (yield* Ref.get(backfillSettled)) return 0
				// System path across orgs: enabled monitors still missing their rule.
				const missing = yield* dbExecute((db) =>
					db.run(
						PG.from(UptimeMonitors)
							.select("id", "orgId", "name", "serviceName", "enabled", "createdBy")
							.where(($) => [$.alertRuleId.isNull(), $.enabled.eq(true)])
							.limit(MAX_RULE_BACKFILL),
					),
				)
				if (missing.length === 0) {
					yield* Ref.set(backfillSettled, true)
					return 0
				}
				// One monitor's failure must not stop the rest; it is retried on the next pass.
				const created = yield* Effect.forEach(missing, (monitor) =>
					backfillOne(monitor).pipe(
						Effect.catch((error) =>
							Effect.logWarning("Uptime rule backfill skipped a monitor").pipe(
								Effect.annotateLogs({
									monitorId: monitor.id,
									orgId: monitor.orgId,
									error: error.message,
								}),
								Effect.as(false),
							),
						),
					),
				)
				const count = created.filter((made) => made).length
				yield* Effect.annotateCurrentSpan("maple.uptime.rules_backfilled", count)
				return count
			}).pipe(Effect.withSpan("UptimeAlertSource.backfillRules"))

			return { observe, backfillRules } satisfies UptimeAlertSourceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
