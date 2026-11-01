// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { AlertValidationError } from "@maple/domain/http"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, Duration, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { type AlertDestinationId, AlertRuleUpsertRequest, OrgId } from "@maple/domain/http"
import { AlertsService } from "./AlertsService"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { Database } from "@maple/backend/platform/DatabaseLive"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertRules, UptimeMonitorStates, UptimeMonitors } from "@maple/db/tables"
import {
	AlertRuleId as AlertRuleIdSchema,
	UptimeMonitorId as UptimeMonitorIdSchema,
	type UptimeMonitorStatus,
} from "@maple/domain/primitives"
import type { UptimeMonitorConfig } from "@maple/domain/uptime"
import { uptimeRuleFields } from "./AlertRuleModel"
import {
	makeWarehouseStub,
	DEFAULT_CLOCK_EPOCH_MS,
	makeLayer,
	asOrgId,
	asUserId,
	adminRoles,
	createWebhookDestination,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

type AlertRuleIdType = AlertRuleIdSchema
type UptimeMonitorIdType = UptimeMonitorIdSchema
type OrgIdType = OrgId

interface SeededMonitor {
	readonly ruleId: AlertRuleIdType
	readonly monitorId: UptimeMonitorIdType
}

/** A monitor with its backing rule and state, as `UptimeMonitorsService.create` writes them. */
const seedUptimeMonitor = (
	testDb: TestDb,
	input: {
		readonly orgId: OrgIdType
		readonly name: string
		readonly serviceName: string | null
		readonly destinationIds: ReadonlyArray<AlertDestinationId>
		readonly config: UptimeMonitorConfig
		readonly status: UptimeMonitorStatus
		readonly error?: string
		readonly lastPingAt?: number
		readonly enabled?: boolean
	},
): Effect.Effect<SeededMonitor> =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = yield* Clock.currentTimeMillis
		const ruleId = AlertRuleIdSchema.make(crypto.randomUUID())
		const monitorId = UptimeMonitorIdSchema.make(crypto.randomUUID())
		const enabled = input.enabled ?? true
		yield* database.execute((db) =>
			db.transaction(
				Effect.gen(function* () {
					yield* db.run(
						PG.insertInto(AlertRules).values({
							id: ruleId,
							orgId: input.orgId,
							...uptimeRuleFields({ ...input, enabled }),
							lastScheduledAt: null,
							createdAt: now,
							updatedAt: now,
							createdBy: "user_uptime",
							updatedBy: "user_uptime",
						}),
					)
					yield* db.run(
						PG.insertInto(UptimeMonitors).values({
							id: monitorId,
							orgId: input.orgId,
							name: input.name,
							kind: input.config._tag,
							configJson: input.config,
							intervalSeconds: 60,
							failuresToDown: 1,
							serviceName: input.serviceName,
							alertRuleId: ruleId,
							heartbeatToken: input.config._tag === "heartbeat" ? crypto.randomUUID() : null,
							enabled,
							createdBy: asUserId("user_uptime"),
							createdAt: now,
							updatedAt: now,
						}),
					)
					yield* db.run(
						PG.insertInto(UptimeMonitorStates).values({
							monitorId,
							orgId: input.orgId,
							status: input.status,
							consecutiveFailures: 0,
							consecutiveSuccesses: 0,
							statusChangedAt: null,
							lastCheckJson:
								input.error === undefined
									? null
									: {
											at: now,
											ok: false,
											durationMs: 80,
											statusCode: 503,
											error: input.error,
											traceId: null,
										},
							recentJson: [],
							lastPingAt: input.lastPingAt ?? null,
							updatedAt: now,
						}),
					)
				}),
			),
		)
		return { ruleId, monitorId }
	}).pipe(Effect.provide(testDb.layer), Effect.orDie)

const httpMonitorConfig: UptimeMonitorConfig = {
	_tag: "http",
	url: "https://checkout.example.com/health",
	method: "GET",
	headers: {},
	assertions: [{ _tag: "status", op: "is", value: "2xx" }],
	timeoutMs: 5000,
}

const setMonitorStatus = (testDb: TestDb, monitorId: string, status: UptimeMonitorStatus) =>
	Effect.promise(() =>
		executeSql(testDb, "update uptime_monitor_states set status = $2 where monitor_id = $1", [
			monitorId,
			status,
		]),
	)

describe("AlertsService uptime rules", () => {
	it.effect("a down monitor opens an incident under its service and recovery resolves it", () => {
		const testDb = createTestDb(trackedDbs)
		const bodies: Array<string> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(String(init?.body ?? ""))
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_uptime_down")
			const userId = asUserId("user_uptime_down")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const { monitorId } = yield* seedUptimeMonitor(testDb, {
				orgId,
				name: "Checkout health",
				serviceName: "checkout-api",
				destinationIds: [destination.id],
				config: httpMonitorConfig,
				status: "down",
				error: "Status 503, expected 2xx",
			})

			yield* alerts.runSchedulerTick()
			const opened = (yield* alerts.listIncidents(orgId)).incidents
			assert.lengthOf(opened, 1)
			assert.strictEqual(opened[0]?.status, "open")
			assert.strictEqual(opened[0]?.groupKey, "checkout-api")
			assert.strictEqual(opened[0]?.signalType, "uptime")
			assert.strictEqual(opened[0]?.severity, "critical")
			const trigger = Schema.decodeUnknownSync(
				Schema.fromJsonString(
					Schema.Struct({
						eventType: Schema.String,
						observed: Schema.Struct({ detail: Schema.String }),
					}),
				),
			)(bodies[0] ?? "")
			assert.deepStrictEqual(trigger, {
				eventType: "trigger",
				observed: { detail: "Status 503, expected 2xx" },
			})

			yield* setMonitorStatus(testDb, monitorId, "up")
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const resolved = (yield* alerts.listIncidents(orgId)).incidents
			assert.strictEqual(resolved[0]?.status, "resolved")
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.sameMembers(
				events.events.map((event) => event.eventType),
				["trigger", "resolve"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: fetchImpl })))
	})

	it.effect("an uptime incident opens and resolves status page incidents on opted-in pages", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_uptime_status_page")
			const { monitorId } = yield* seedUptimeMonitor(testDb, {
				orgId,
				name: "Checkout health",
				serviceName: "checkout-api",
				destinationIds: [],
				config: httpMonitorConfig,
				status: "down",
			})
			const pages = [
				{ id: crypto.randomUUID(), slug: "published-page", autoIncidents: "publish" },
				{ id: crypto.randomUUID(), slug: "draft-page", autoIncidents: "draft" },
				{ id: crypto.randomUUID(), slug: "off-page", autoIncidents: "off" },
			]
			yield* Effect.forEach(pages, (page) =>
				Effect.promise(() =>
					executeSql(
						testDb,
						`INSERT INTO status_pages (id, org_id, name, slug, auto_incidents, created_by, created_at, updated_at)
						 VALUES ($1, $2, 'Acme', $3, $4, 'user_uptime', now(), now())`,
						[page.id, orgId, page.slug, page.autoIncidents],
					).then(() =>
						executeSql(
							testDb,
							`INSERT INTO status_page_components (id, org_id, page_id, name, monitor_id, created_at, updated_at)
							 VALUES ($1, $2, $3, 'Checkout', $4, now(), now())`,
							[crypto.randomUUID(), orgId, page.id, monitorId],
						),
					),
				),
			)
			const pageIncidents = () =>
				Effect.promise(() =>
					testDb.pglite.query<{
						slug: string
						title: string
						status: string
						published: boolean
						alert_incident_id: string | null
						updates: number
					}>(
						`SELECT p.slug, i.title, i.status, i.published, i.alert_incident_id,
							(SELECT count(*)::int FROM status_page_incident_updates u WHERE u.incident_id = i.id) AS updates
						 FROM status_page_incidents i JOIN status_pages p ON p.id = i.page_id ORDER BY p.slug`,
					),
				).pipe(Effect.map((result) => result.rows))

			yield* alerts.runSchedulerTick()
			const alertIncidentId = (yield* alerts.listIncidents(orgId)).incidents[0]?.id
			assert.deepStrictEqual(yield* pageIncidents(), [
				{
					slug: "draft-page",
					title: "Checkout is down",
					status: "investigating",
					published: false,
					alert_incident_id: alertIncidentId ?? null,
					updates: 1,
				},
				{
					slug: "published-page",
					title: "Checkout is down",
					status: "investigating",
					published: true,
					alert_incident_id: alertIncidentId ?? null,
					updates: 1,
				},
			])

			yield* setMonitorStatus(testDb, monitorId, "up")
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			assert.deepStrictEqual(
				(yield* pageIncidents()).map((row) => [row.slug, row.status, row.updates]),
				[
					["draft-page", "resolved", 2],
					["published-page", "resolved", 2],
				],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}))))
	})

	it.effect("a monitor created before backing rules gets one, once, and then fires", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_uptime_backfill")
			const { ruleId, monitorId } = yield* seedUptimeMonitor(testDb, {
				orgId,
				name: "Legacy check",
				serviceName: null,
				destinationIds: [],
				config: httpMonitorConfig,
				status: "down",
				error: "Status 503, expected 2xx",
			})
			// As the v2 API created monitors before this shipped: no backing rule.
			yield* Effect.promise(async () => {
				await executeSql(testDb, "update uptime_monitors set alert_rule_id = null where id = $1", [
					monitorId,
				])
				await executeSql(testDb, "delete from alert_rules where id = $1", [ruleId])
			})
			const ruleCount = Effect.promise(() =>
				queryFirstRow<{ readonly n: number }>(
					testDb,
					"select count(*)::int as n from alert_rules where org_id = $1",
					[orgId],
				),
			)

			yield* alerts.runSchedulerTick()
			assert.strictEqual((yield* ruleCount)?.n, 1)
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			assert.strictEqual((yield* ruleCount)?.n, 1)
			const opened = (yield* alerts.listIncidents(orgId)).incidents
			assert.deepStrictEqual(
				opened.map((incident) => [incident.ruleName, incident.status]),
				[["Legacy check", "open"]],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}))))
	})

	it.effect("a monitor whose backing rule cannot be created does not block the others", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_uptime_backfill_isolated")
			const seed = (name: string) =>
				seedUptimeMonitor(testDb, {
					orgId,
					name,
					serviceName: null,
					destinationIds: [],
					config: httpMonitorConfig,
					status: "down",
					error: "Status 503, expected 2xx",
				})
			// The first keeps its old rule row, so a new rule with its name violates the unique name.
			const blocked = yield* seed("Blocked check")
			const legacy = yield* seed("Legacy check")
			yield* Effect.promise(async () => {
				await executeSql(
					testDb,
					"update uptime_monitors set alert_rule_id = null where org_id = $1",
					[orgId],
				)
				await executeSql(testDb, "delete from alert_rules where id = $1", [legacy.ruleId])
			})
			const ruleOf = (monitorId: string) =>
				Effect.promise(() =>
					queryFirstRow<{ readonly alert_rule_id: string | null }>(
						testDb,
						"select alert_rule_id from uptime_monitors where id = $1",
						[monitorId],
					),
				)

			yield* alerts.runSchedulerTick()
			assert.isNull((yield* ruleOf(blocked.monitorId))?.alert_rule_id)
			assert.isNotNull((yield* ruleOf(legacy.monitorId))?.alert_rule_id)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}))))
	})

	it.effect("a paused monitor never fires, and pausing resolves an open incident", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_uptime_paused")
			yield* seedUptimeMonitor(testDb, {
				orgId,
				name: "Paused check",
				serviceName: null,
				destinationIds: [],
				config: httpMonitorConfig,
				status: "paused",
				error: "Status 503, expected 2xx",
				enabled: false,
			})
			const live = yield* seedUptimeMonitor(testDb, {
				orgId,
				name: "Live check",
				serviceName: null,
				destinationIds: [],
				config: httpMonitorConfig,
				status: "down",
				error: "Connection refused",
			})

			yield* alerts.runSchedulerTick()
			const opened = (yield* alerts.listIncidents(orgId)).incidents
			assert.deepStrictEqual(
				opened.map((incident) => [incident.ruleName, incident.groupKey, incident.status]),
				[["Live check", "__total__", "open"]],
			)

			// Pausing the monitor disables its rule; the disabled-rule sweep resolves the incident.
			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set enabled = false where id = $1", [live.ruleId]),
			)
			yield* setMonitorStatus(testDb, live.monitorId, "paused")
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const after = (yield* alerts.listIncidents(orgId)).incidents
			assert.deepStrictEqual(
				after.map((incident) => [incident.ruleName, incident.status]),
				[["Live check", "resolved"]],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}))))
	})

	it.effect("a heartbeat goes down only once its interval and grace have passed", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_uptime_heartbeat")
			const { monitorId } = yield* seedUptimeMonitor(testDb, {
				orgId,
				name: "Nightly backup",
				serviceName: "backup-job",
				destinationIds: [],
				config: {
					_tag: "heartbeat",
					schedule: { _tag: "interval", seconds: 300 },
					graceSeconds: 60,
				},
				status: "up",
				lastPingAt: DEFAULT_CLOCK_EPOCH_MS,
			})
			const tickAt = (minutes: number) =>
				Effect.gen(function* () {
					yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS + minutes * 60_000)
					yield* alerts.runSchedulerTick()
					return (yield* alerts.listIncidents(orgId)).incidents
				})

			assert.lengthOf(yield* tickAt(5), 0)
			// 6 minutes is the interval plus the grace exactly: not yet overdue.
			assert.lengthOf(yield* tickAt(6), 0)
			const overdue = yield* tickAt(7)
			assert.deepStrictEqual(
				overdue.map((incident) => [incident.groupKey, incident.status]),
				[["backup-job", "open"]],
			)
			const state = yield* Effect.promise(() =>
				queryFirstRow<{ status: string; last_check_json: { readonly error: string } }>(
					testDb,
					"select status, last_check_json from uptime_monitor_states where monitor_id = $1",
					[monitorId],
				),
			)
			assert.strictEqual(state?.status, "down")
			assert.strictEqual(state?.last_check_json.error, "No ping since 2023-11-14 22:13 UTC (7 min ago)")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}))))
	})

	it.effect("a missed heartbeat counts as a down check and marks the pages showing it", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_uptime_heartbeat_page")
			const { monitorId } = yield* seedUptimeMonitor(testDb, {
				orgId,
				name: "Nightly backup",
				serviceName: "backup-job",
				destinationIds: [],
				config: { _tag: "heartbeat", schedule: { _tag: "interval", seconds: 300 }, graceSeconds: 60 },
				status: "up",
				lastPingAt: DEFAULT_CLOCK_EPOCH_MS,
			})
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO status_pages (id, org_id, name, slug, created_by, created_at, updated_at)
					 VALUES ('11111111-1111-4111-8111-111111111111', $1, 'Acme', 'acme', 'user_1', now(), now())`,
					[orgId],
				).then(() =>
					executeSql(
						testDb,
						`INSERT INTO status_page_components (id, org_id, page_id, name, monitor_id, created_at, updated_at)
						 VALUES ('22222222-2222-4222-8222-222222222222', $1, '11111111-1111-4111-8111-111111111111', 'Backups', $2, now(), now())`,
						[orgId, monitorId],
					),
				),
			)
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS + 7 * 60_000)
			yield* alerts.runSchedulerTick()
			const page = yield* Effect.promise(() =>
				queryFirstRow<{ revision: string }>(testDb, "select revision::text from status_pages"),
			)
			const daily = yield* Effect.promise(() =>
				queryFirstRow<{ checks: number; down_checks: number }>(
					testDb,
					"select checks, down_checks from uptime_monitor_daily where monitor_id = $1",
					[monitorId],
				),
			)
			assert.strictEqual(page?.revision, "2")
			assert.deepStrictEqual(daily, { checks: 1, down_checks: 1 })
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}))))
	})

	it.effect(
		"the generic rule APIs refuse to create, edit or delete uptime rules and do not list them",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_uptime_generic")
				const userId = asUserId("user_uptime_generic")
				const request = new AlertRuleUpsertRequest({
					name: "Sneaky uptime",
					severity: "critical",
					signalType: "uptime",
					comparator: "gte",
					threshold: 1,
					windowMinutes: 1,
				})
				const created = yield* Effect.flip(alerts.createRule(orgId, userId, adminRoles, request))
				assert.instanceOf(created, AlertValidationError)

				const { ruleId } = yield* seedUptimeMonitor(testDb, {
					orgId,
					name: "Monitor rule",
					serviceName: null,
					destinationIds: [],
					config: httpMonitorConfig,
					status: "up",
				})
				assert.lengthOf((yield* alerts.listRules(orgId)).rules, 0)
				const edited = yield* Effect.flip(
					alerts.updateRule(orgId, userId, adminRoles, ruleId, request),
				)
				assert.strictEqual(edited._tag, "@maple/http/errors/AlertValidationError")
				const deleted = yield* Effect.flip(alerts.deleteRule(orgId, adminRoles, ruleId))
				assert.strictEqual(deleted._tag, "@maple/http/errors/AlertRuleNotFoundError")
			}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}))))
		},
	)
})
