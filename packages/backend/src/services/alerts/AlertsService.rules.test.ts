// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { AlertValidationError } from "@maple/domain/http"
import { ChatAlertPoster } from "./ChatAlertPoster"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Exit, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	AlertDestinationInUseError,
	AlertForbiddenError,
	AlertRecipientSelectionError,
	type AlertDestinationId,
	ChatConnectorId,
	ChatWorkspaceId,
	AlertRuleUpsertRequest,
} from "@maple/domain/http"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { AlertsService } from "./AlertsService"
import { baselineWarehouseCapabilities } from "@maple/query-engine"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { compiledQueryOf } from "@maple/query-engine/execution"
import {
	getError,
	emptyWarehouseRows,
	tracesRow,
	makeWarehouseStub,
	DEFAULT_CLOCK_EPOCH_MS,
	stubEmailService,
	makeLayer,
	asOrgId,
	asUserId,
	adminRoles,
	memberRoles,
	createWebhookDestination,
	createErrorRateRule,
	okFetch,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

describe("AlertsService", () => {
	it.effect("evaluates logs query alerts in testRule without failing validation", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const result = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_logs_test")
				const userId = asUserId("user_logs_test")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)

				return yield* alerts.testRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: "Checkout error logs",
						severity: "critical",
						enabled: true,
						signalType: "builder_query",
						queryBuilderDraft: {
							id: "q",
							name: "A",
							dataSource: "logs",
							aggregation: "count",
							whereClause: 'service.name = "checkout" AND severity = "error"',
						},
						comparator: "gt",
						threshold: 10,
						windowMinutes: 5,
						minimumSampleCount: 1,
						consecutiveBreachesRequired: 2,
						consecutiveHealthyRequired: 2,
						renotifyIntervalMinutes: 30,
						destinationIds: [destination.id],
					}),
				)
			}).pipe(
				Effect.provide(
					makeLayer(
						testDb,
						makeWarehouseStub({
							logsAggregateRows: [
								{
									bucket: new Date(DEFAULT_CLOCK_EPOCH_MS)
										.toISOString()
										.replace("T", " ")
										.slice(0, 19),
									groupName: "all",
									count: 42,
								},
							],
						}),
					),
				),
			)

			assert.strictEqual(result.status, "breached")
			assert.strictEqual(result.value, 42)
			assert.strictEqual(result.sampleCount, 42)
		})
	})

	it.effect("evaluates a builder_query rule once, whatever service scope it carries", () => {
		const testDb = createTestDb(trackedDbs)
		const request = (serviceNames: ReadonlyArray<string>, destinationId: AlertDestinationId) =>
			new AlertRuleUpsertRequest({
				name: "Error logs",
				severity: "critical",
				enabled: true,
				serviceNames: [...serviceNames],
				signalType: "builder_query",
				queryBuilderDraft: {
					id: "q",
					name: "A",
					dataSource: "logs",
					aggregation: "count",
					whereClause: 'severity = "error"',
				},
				comparator: "gt",
				threshold: 10,
				windowMinutes: 5,
				minimumSampleCount: 1,
				consecutiveBreachesRequired: 1,
				consecutiveHealthyRequired: 2,
				renotifyIntervalMinutes: 30,
				destinationIds: [destinationId],
			})

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_builder_scope")
			const userId = asUserId("user_builder_scope")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			// The draft owns the scope, so a write drops the service fields.
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				request(["checkout", "payments"], destination.id),
			)
			assert.deepStrictEqual([...rule.serviceNames], [])

			// A row stored with them anyway evaluates once: one incident per breach,
			// not one per listed service.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`update alert_rules set service_names_json = '["checkout","payments"]'::jsonb where id = $1`,
					[rule.id],
				),
			)
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({
						logsAggregateRows: [
							{
								bucket: new Date(DEFAULT_CLOCK_EPOCH_MS)
									.toISOString()
									.replace("T", " ")
									.slice(0, 19),
								groupName: "all",
								count: 42,
							},
						],
					}),
					{ fetch: okFetch },
				),
			),
		)
	})

	it.effect("compiles and evaluates a raw SQL query alert", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const result = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_raw_sql_test")
				const userId = asUserId("user_raw_sql_test")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)

				return yield* alerts.testRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: "Raw SQL alert",
						severity: "critical",
						enabled: true,
						signalType: "raw_query",
						rawQuerySql:
							"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
						rawQueryReducer: "max",
						comparator: "gt",
						threshold: 100,
						windowMinutes: 5,
						minimumSampleCount: 0,
						consecutiveBreachesRequired: 2,
						consecutiveHealthyRequired: 2,
						renotifyIntervalMinutes: 30,
						destinationIds: [destination.id],
					}),
				)
			}).pipe(
				Effect.provide(
					makeLayer(
						testDb,
						makeWarehouseStub({
							rawQueryRows: [
								{ value: 120, samples: 8 },
								{ value: 240, samples: 12 },
							],
						}),
					),
				),
			)

			assert.strictEqual(result.status, "breached")
			assert.strictEqual(result.value, 240)
			assert.strictEqual(result.sampleCount, 20)
		})
	})

	it.effect("accepts a builder query when lowering emits a warning", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_builder_warning")
			const userId = asUserId("user_builder_warning")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Grouped metrics alert",
					severity: "warning",
					signalType: "builder_query",
					queryBuilderDraft: {
						id: "alert-query",
						name: "A",
						dataSource: "metrics",
						aggregation: "avg",
						metricName: "http.server.request.duration",
						metricType: "histogram",
						whereClause: "",
						addOns: {
							groupBy: true,
							having: false,
							orderBy: false,
							limit: false,
							legend: false,
						},
						groupBy: ["attr.http.method", "attr.http.route"],
					},
					comparator: "gt",
					threshold: 100,
					windowMinutes: 5,
					destinationIds: [destination.id],
				}),
			)

			assert.strictEqual(rule.signalType, "builder_query")
			assert.deepStrictEqual(rule.queryBuilderDraft?.groupBy, ["attr.http.method", "attr.http.route"])
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ metricsAggregateRows: emptyWarehouseRows })),
			),
		)
	})

	const VALID_PD_KEY = "e93facc04764012d7bfb002500d5d1a6" // 32 hex chars
	const REST_API_TOKEN = "u+0123456789abcdefgh" // 20 chars, '+' — the common wrong paste

	it.effect("rejects a PagerDuty key of the wrong shape without calling PagerDuty", () => {
		const testDb = createTestDb(trackedDbs)
		const requests: string[] = []
		const fetchImpl = (async (input: RequestInfo | URL) => {
			requests.push(String(input))
			return new Response("", { status: 202 })
		}) as typeof fetch

		return Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.createDestination(
					asOrgId("org_pd_shape"),
					asUserId("user_pd_shape"),
					adminRoles,
					{ type: "pagerduty", name: "Paging", enabled: true, integrationKey: REST_API_TOKEN },
				)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
						fetch: fetchImpl,
					}),
				),
				Effect.exit,
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, AlertValidationError)
			assert.include(failure.message, "32-character Events API v2 routing key")
			// Format check short-circuits before any network call.
			assert.lengthOf(requests, 0)
		})
	})

	it.effect("rejects a well-formed PagerDuty key that PagerDuty reports invalid", () => {
		const testDb = createTestDb(trackedDbs)
		const requests: Array<{ url: string; body: string }> = []
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(input), body: String(init?.body ?? "") })
			return new Response(
				JSON.stringify({
					status: "invalid event",
					message: "Event object is invalid",
					errors: ["Invalid routing key"],
				}),
				{ status: 400 },
			)
		}) as typeof fetch

		return Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.createDestination(
					asOrgId("org_pd_invalid"),
					asUserId("user_pd_invalid"),
					adminRoles,
					{ type: "pagerduty", name: "Paging", enabled: true, integrationKey: VALID_PD_KEY },
				)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
						fetch: fetchImpl,
					}),
				),
				Effect.exit,
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, AlertValidationError)
			assert.include(failure.message, "Invalid routing key")
			assert.lengthOf(requests, 1)
			assert.strictEqual(requests[0]?.url, "https://events.pagerduty.com/v2/enqueue")
			// Validation uses a no-op resolve so it never creates an incident.
			assert.include(requests[0]?.body ?? "", '"event_action":"resolve"')
		})
	})

	it.effect("accepts a PagerDuty key that PagerDuty confirms", () => {
		const testDb = createTestDb(trackedDbs)
		const fetchImpl = (async () => new Response("", { status: 202 })) as typeof fetch
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const destination = yield* alerts.createDestination(
				asOrgId("org_pd_ok"),
				asUserId("user_pd_ok"),
				adminRoles,
				{ type: "pagerduty", name: "Paging", enabled: true, integrationKey: VALID_PD_KEY },
			)
			assert.strictEqual(destination.type, "pagerduty")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("creates the destination when PagerDuty is unreachable (fails open)", () => {
		const testDb = createTestDb(trackedDbs)
		const fetchImpl = (async () => {
			throw new Error("network down")
		}) as typeof fetch
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const destination = yield* alerts.createDestination(
				asOrgId("org_pd_open"),
				asUserId("user_pd_open"),
				adminRoles,
				{ type: "pagerduty", name: "Paging", enabled: true, integrationKey: VALID_PD_KEY },
			)
			assert.strictEqual(destination.type, "pagerduty")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("names only a channel the workspace lists, on create and on a channel change", () => {
		const testDb = createTestDb(trackedDbs)
		const workspaceId = Schema.decodeUnknownSync(ChatWorkspaceId)("33333333-3333-4333-8333-333333333333")
		const orgId = asOrgId("org_chat_dest")
		const userId = asUserId("user_chat")
		// The workspace's listing, as the real poster reads it from the connector: a channel not in
		// it — say one in another org's guild, reachable with a shared bot token — is refused.
		const listed = new Map([
			["channel-1", "incidents"],
			["channel-2", "oncall"],
		])
		const lookups: Array<string> = []
		const poster = Layer.succeed(ChatAlertPoster, {
			post: () => Effect.die("no alert is posted here"),
			findChannel: (_orgId, _workspaceId, channelId) =>
				Effect.suspend(() => {
					lookups.push(channelId)
					const channelName = listed.get(channelId)
					return channelName === undefined
						? Effect.fail(new AlertValidationError({ message: "not listed", details: [] }))
						: Effect.succeed({
								connector: Schema.decodeUnknownSync(ChatConnectorId)("testchat"),
								workspaceName: "Acme Engineering",
								channelName,
							})
				}),
		})
		const request = { type: "chat" as const, name: "Incidents", workspaceId, channelId: "channel-1" }
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const foreign = yield* alerts
				.createDestination(orgId, userId, adminRoles, { ...request, channelId: "their-channel" })
				.pipe(Effect.flip)
			assert.instanceOf(foreign, AlertValidationError)

			const destination = yield* alerts.createDestination(orgId, userId, adminRoles, request)
			// Connector and channel name come from the lookup, never the request.
			assert.strictEqual(destination.chatConnector, "testchat")
			assert.strictEqual(destination.chatWorkspaceId, workspaceId)
			assert.strictEqual(destination.summary, "Acme Engineering")
			assert.strictEqual(destination.channelLabel, "#incidents")

			const refused = yield* alerts
				.updateDestination(orgId, userId, adminRoles, destination.id, {
					type: "chat",
					channelId: "their-channel",
				})
				.pipe(Effect.flip)
			assert.instanceOf(refused, AlertValidationError)

			const renamed = yield* alerts.updateDestination(orgId, userId, adminRoles, destination.id, {
				type: "chat",
				name: "Renamed",
			})
			assert.strictEqual(renamed.channelLabel, "#incidents")

			const moved = yield* alerts.updateDestination(orgId, userId, adminRoles, destination.id, {
				type: "chat",
				channelId: "channel-2",
			})
			assert.strictEqual(moved.channelLabel, "#oncall")
			assert.strictEqual(moved.chatWorkspaceId, workspaceId)
			// A rename checks nothing; every channel that would be stored was checked.
			assert.deepStrictEqual(lookups, ["their-channel", "channel-1", "their-channel", "channel-2"])
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }),
					undefined,
					undefined,
					poster,
				),
			),
		)
	})

	it.effect("skips PagerDuty validation on update when the key is left blank", () => {
		const testDb = createTestDb(trackedDbs)
		let calls = 0
		const fetchImpl = (async () => {
			calls += 1
			return new Response("", { status: 202 })
		}) as typeof fetch
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_pd_update")
			const userId = asUserId("user_pd_update")
			const created = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "pagerduty",
				name: "Paging",
				enabled: true,
				integrationKey: VALID_PD_KEY,
			})
			assert.strictEqual(calls, 1) // create validated once

			const updated = yield* alerts.updateDestination(orgId, userId, adminRoles, created.id, {
				type: "pagerduty",
				name: "Paging renamed",
			})
			assert.strictEqual(updated.name, "Paging renamed")
			assert.strictEqual(calls, 1) // no re-validation when the key is omitted
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("creates an email destination and delivers a test email to every member", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<{ to: string; subject: string; html: string }> = []
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_email_dest")
			const userId = asUserId("user_email_dest")
			const destination = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "email",
				name: "On-call inbox",
				enabled: true,
				memberUserIds: ["user_ops", "user_oncall"],
			})
			assert.strictEqual(destination.type, "email")
			// Summary uses the member's display name; channelLabel the email.
			assert.strictEqual(destination.summary, "Ops Team +1 more")
			assert.strictEqual(destination.channelLabel, "ops@acme.test")
			assert.deepStrictEqual(destination.memberUserIds, ["user_ops", "user_oncall"])

			const response = yield* alerts.testDestination(orgId, userId, adminRoles, destination.id)
			assert.isTrue(response.success)
			assert.deepStrictEqual(
				sent.map((s) => s.to),
				["ops@acme.test", "oncall@acme.test"],
			)
			// The synthetic test notification renders under the rule name "Test alert".
			assert.include(sent[0]?.subject ?? "", "Test alert")
			assert.include(sent[0]?.html ?? "", "Test alert")
			assert.include(sent[0]?.html ?? "", "Open in Maple")
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }),
					undefined,
					stubEmailService(sent),
				),
			),
		)
	})

	it.effect("rejects email destinations targeting users outside the workspace", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.createDestination(
					asOrgId("org_email_invalid"),
					asUserId("user_email_invalid"),
					adminRoles,
					{ type: "email", name: "Bad", enabled: true, memberUserIds: ["user_stranger"] },
				)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows })),
				),
				Effect.exit,
			)

			assert.isTrue(Exit.isFailure(exit))
			const failure = getError(exit)
			assert.instanceOf(failure, AlertRecipientSelectionError)
			assert.include(failure.message, "not members")
			assert.deepStrictEqual(failure.unknownUserIds, ["user_stranger"])
		})
	})

	it.effect("replaces email members on update and keeps them when omitted", () => {
		const testDb = createTestDb(trackedDbs)
		const sent: Array<{ to: string; subject: string; html: string }> = []
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_email_update")
			const userId = asUserId("user_email_update")
			const created = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "email",
				name: "On-call inbox",
				enabled: true,
				memberUserIds: ["user_ops"],
			})

			// Omitted member ids → recipients unchanged.
			const renamed = yield* alerts.updateDestination(orgId, userId, adminRoles, created.id, {
				type: "email",
				name: "Renamed inbox",
			})
			assert.strictEqual(renamed.name, "Renamed inbox")
			assert.strictEqual(renamed.summary, "Ops Team")

			// Supplied member ids → replaced wholesale.
			const replaced = yield* alerts.updateDestination(orgId, userId, adminRoles, created.id, {
				type: "email",
				memberUserIds: ["user_oncall", "user_lead"],
			})
			assert.strictEqual(replaced.summary, "oncall@acme.test +1 more")
			assert.strictEqual(replaced.channelLabel, "oncall@acme.test")
			assert.deepStrictEqual(replaced.memberUserIds, ["user_oncall", "user_lead"])

			yield* alerts.testDestination(orgId, userId, adminRoles, created.id)
			assert.deepStrictEqual(
				sent.map((s) => s.to),
				["oncall@acme.test", "lead@acme.test"],
			)
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }),
					undefined,
					stubEmailService(sent),
				),
			),
		)
	})

	it.effect("opens per-service incidents for grouped logs query alerts", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_logs_grouped")
			const userId = asUserId("user_logs_grouped")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "All services error logs",
					severity: "critical",
					enabled: true,
					signalType: "builder_query",
					queryBuilderDraft: {
						id: "q",
						name: "A",
						dataSource: "logs",
						aggregation: "count",
						whereClause: 'severity = "error"',
						groupBy: ["service.name"],
						addOns: {
							groupBy: true,
							having: false,
							orderBy: false,
							limit: false,
							legend: false,
						},
					},
					groupBy: ["service.name"],
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					minimumSampleCount: 1,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.groupKey, "svc-breach")
			assert.strictEqual(incidents.incidents[0]?.status, "open")
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({
						logsAggregateByServiceRows: [
							{ bucket: "2026-01-01 00:00:00", groupName: "svc-breach", count: 14 },
							{ bucket: "2026-01-01 00:00:00", groupName: "svc-healthy", count: 3 },
						],
					}),
					{ fetch: okFetch },
				),
			),
		)
	})

	// Regression: the web form persists rule-level groupBy as null for
	// builder_query rules — the grouping lives only in the draft. The scheduler
	// must derive groupedness from the compiled plan, not rule.groupBy, or it
	// evaluates only the first group under "__total__".
	it.effect("fans out per group for builder_query rules grouped only via the draft", () => {
		const testDb = createTestDb(trackedDbs)

		const groupedLogsDraft = (groupBy: string[]) => ({
			id: "q",
			name: "A",
			dataSource: "logs" as const,
			aggregation: "count" as const,
			whereClause: 'severity = "error"',
			groupBy,
			addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
		})

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_draft_grouped")
			const userId = asUserId("user_draft_grouped")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Error logs by service (draft grouping)",
					severity: "critical",
					enabled: true,
					signalType: "builder_query",
					queryBuilderDraft: groupedLogsDraft(["service.name"]),
					// Deliberately NO rule-level groupBy — matches what the web form sends.
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					minimumSampleCount: 1,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)

			// Simulate the prod failure mode: a stale "__total__" state row left
			// behind from when this rule evaluated ungrouped.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`insert into alert_rule_states (org_id, rule_id, group_key, consecutive_breaches, consecutive_healthy, last_status, updated_at)
					 values ($1, $2, '__total__', 0, 2, 'healthy', now())`,
					[orgId, rule.id],
				),
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			// The breaching group fires even though the healthy group sorts first.
			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.groupKey, "zzz-breach")
			assert.strictEqual(incidents.incidents[0]?.status, "open")

			// Per-group state rows exist; the stale "__total__" row self-healed away.
			const stateCounts = yield* Effect.promise(() =>
				queryFirstRow<{ total_rows: number; grouped_rows: number }>(
					testDb,
					`select
						count(*) filter (where group_key = '__total__')::int as total_rows,
						count(*) filter (where group_key <> '__total__')::int as grouped_rows
					 from alert_rule_states where rule_id = $1`,
					[rule.id],
				),
			)
			assert.strictEqual(stateCounts?.total_rows, 0)
			assert.strictEqual(stateCounts?.grouped_rows, 2)
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({
						logsAggregateByServiceRows: [
							{ bucket: "2026-01-01 00:00:00", groupName: "aaa-healthy", count: 3 },
							{ bucket: "2026-01-01 00:00:00", groupName: "zzz-breach", count: 14 },
						],
					}),
					{ fetch: okFetch },
				),
			),
		)
	})

	it.effect("deletes stale per-group state rows once a rule evaluates ungrouped", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_ungrouped_heal")
			const userId = asUserId("user_ungrouped_heal")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Leftover from a previous grouped configuration.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`insert into alert_rule_states (org_id, rule_id, group_key, consecutive_breaches, consecutive_healthy, last_status, updated_at)
					 values ($1, $2, 'svc-stale', 1, 0, 'breached', now())`,
					[orgId, rule.id],
				),
			)

			yield* alerts.runSchedulerTick()

			const staleCount = yield* Effect.promise(() =>
				queryFirstRow<{ stale: number }>(
					testDb,
					`select count(*)::int as stale from alert_rule_states where rule_id = $1 and group_key <> '__total__'`,
					[rule.id],
				),
			)
			assert.strictEqual(staleCount?.stale, 0)
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({
						tracesAggregateRows: [
							tracesRow({
								count: 200,
								avgDuration: 20,
								p50Duration: 10,
								p95Duration: 80,
								p99Duration: 160,
								errorRate: 1,
								satisfiedCount: 195,
								toleratingCount: 3,
								apdexScore: 0.9825,
							}),
						],
					}),
					{ fetch: okFetch },
				),
			),
		)
	})

	it.effect("treats a draft-only grouping change as structural and resets state", () => {
		const testDb = createTestDb(trackedDbs)

		const draft = (groupBy: string[]) => ({
			id: "q",
			name: "A",
			dataSource: "logs" as const,
			aggregation: "count" as const,
			whereClause: 'severity = "error"',
			groupBy,
			addOns: { groupBy: true, having: false, orderBy: false, limit: false, legend: false },
		})
		const request = (overrides: Partial<{ threshold: number; groupBy: string[] }>) =>
			new AlertRuleUpsertRequest({
				name: "Error logs grouping change",
				severity: "critical",
				enabled: true,
				signalType: "builder_query",
				queryBuilderDraft: draft(overrides.groupBy ?? ["service.name"]),
				comparator: "gt",
				threshold: overrides.threshold ?? 10,
				windowMinutes: 5,
				minimumSampleCount: 1,
				consecutiveBreachesRequired: 2,
				consecutiveHealthyRequired: 2,
				renotifyIntervalMinutes: 30,
				destinationIds: [],
			})

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_draft_group_change")
			const userId = asUserId("user_draft_group_change")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const withDestination = (overrides: Partial<{ threshold: number; groupBy: string[] }>) =>
				new AlertRuleUpsertRequest({ ...request(overrides), destinationIds: [destination.id] })

			const rule = yield* alerts.createRule(orgId, userId, adminRoles, withDestination({}))

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const open = yield* alerts.listIncidents(orgId)
			assert.strictEqual(open.incidents[0]?.status, "open")

			// A non-structural edit (threshold) keeps the incident open.
			yield* alerts.updateRule(orgId, userId, adminRoles, rule.id, withDestination({ threshold: 12 }))
			const afterThreshold = yield* alerts.listIncidents(orgId)
			assert.strictEqual(afterThreshold.incidents[0]?.status, "open")

			// Changing only the draft's grouping is structural: incidents resolve
			// and all state rows reset.
			yield* alerts.updateRule(
				orgId,
				userId,
				adminRoles,
				rule.id,
				withDestination({ threshold: 12, groupBy: ["severity"] }),
			)
			const afterGrouping = yield* alerts.listIncidents(orgId)
			assert.strictEqual(afterGrouping.incidents[0]?.status, "resolved")
			const stateCount = yield* Effect.promise(() =>
				queryFirstRow<{ remaining: number }>(
					testDb,
					`select count(*)::int as remaining from alert_rule_states where rule_id = $1`,
					[rule.id],
				),
			)
			assert.strictEqual(stateCount?.remaining, 0)
		}).pipe(
			Effect.provide(
				makeLayer(
					testDb,
					makeWarehouseStub({
						logsAggregateByServiceRows: [
							{ bucket: "2026-01-01 00:00:00", groupName: "zzz-breach", count: 14 },
						],
					}),
					{ fetch: okFetch },
				),
			),
		)
	})

	it.effect("testRule surfaces a breaching non-first group for draft-grouped rules", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const result = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_test_draft_grouped")
				const userId = asUserId("user_test_draft_grouped")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)

				return yield* alerts.testRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: "Grouped test rule",
						severity: "critical",
						enabled: true,
						signalType: "builder_query",
						queryBuilderDraft: {
							id: "q",
							name: "A",
							dataSource: "logs",
							aggregation: "count",
							whereClause: 'severity = "error"',
							groupBy: ["service.name"],
							addOns: {
								groupBy: true,
								having: false,
								orderBy: false,
								limit: false,
								legend: false,
							},
						},
						comparator: "gt",
						threshold: 10,
						windowMinutes: 5,
						minimumSampleCount: 1,
						consecutiveBreachesRequired: 2,
						consecutiveHealthyRequired: 2,
						renotifyIntervalMinutes: 30,
						destinationIds: [destination.id],
					}),
				)
			}).pipe(
				Effect.provide(
					makeLayer(
						testDb,
						makeWarehouseStub({
							logsAggregateByServiceRows: [
								{ bucket: "2026-01-01 00:00:00", groupName: "aaa-healthy", count: 3 },
								{ bucket: "2026-01-01 00:00:00", groupName: "zzz-breach", count: 14 },
							],
						}),
					),
				),
			)

			assert.strictEqual(result.status, "breached")
			assert.strictEqual(result.value, 14)
		})
	})

	it.effect("blocks destination deletion when rules still reference it", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_delete_guard")
				const userId = asUserId("user_delete_guard")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				return yield* alerts.deleteDestination(orgId, adminRoles, destination.id)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows })),
				),
				Effect.exit,
			)

			const failure = getError(exit)
			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, AlertDestinationInUseError)
			assert.isString((failure as { destinationId: unknown }).destinationId)
			assert.deepStrictEqual((failure as { ruleNames: ReadonlyArray<string> }).ruleNames, [
				"Checkout error rate",
			])
		})
	})

	it.effect("rejects destination creation for non-admin members", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const exit = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.createDestination(
					asOrgId("org_forbidden"),
					asUserId("user_forbidden"),
					memberRoles,
					{
						type: "webhook",
						name: "Member webhook",
						enabled: true,
						url: "https://example.com/member",
					},
				)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows })),
				),
				Effect.exit,
			)

			const failure = getError(exit)

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, AlertForbiddenError)
		})
	})

	it.effect("dedupes destinationIds on create and update, preserving selection order", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_dedupe_destinations")
			const userId = asUserId("user_dedupe_destinations")

			const primary = yield* createWebhookDestination(alerts, orgId, userId)
			const secondary = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "webhook",
				name: "Secondary webhook",
				enabled: true,
				url: "https://example.com/secondary",
				signingSecret: "webhook-secret-2",
			})

			const baseRule = {
				name: "Duplicate destination rule",
				severity: "warning",
				enabled: true,
				serviceNames: ["checkout"],
				signalType: "error_rate",
				comparator: "gt",
				threshold: 5,
				windowMinutes: 5,
				minimumSampleCount: 10,
				consecutiveBreachesRequired: 2,
				consecutiveHealthyRequired: 2,
				renotifyIntervalMinutes: 30,
			} as const

			// Create with the same id repeated, interleaved with a distinct id — the
			// duplicates collapse but the first-seen order survives.
			const created = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					...baseRule,
					destinationIds: [primary.id, secondary.id, primary.id],
				}),
			)
			assert.deepStrictEqual(created.destinationIds, [primary.id, secondary.id])

			// Updating with duplicates is deduped on the write path too.
			const updated = yield* alerts.updateRule(
				orgId,
				userId,
				adminRoles,
				created.id,
				new AlertRuleUpsertRequest({
					...baseRule,
					destinationIds: [secondary.id, secondary.id],
				}),
			)
			assert.deepStrictEqual(updated.destinationIds, [secondary.id])

			// The persisted row read back is deduped, not just the returned document.
			const rules = yield* alerts.listRules(orgId)
			assert.lengthOf(rules.rules, 1)
			assert.deepStrictEqual(rules.rules[0]?.destinationIds, [secondary.id])
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("round-trips and normalizes rule tags through create/update/list", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_rule_tags")
			const userId = asUserId("user_rule_tags")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			const baseRule = {
				name: "Tagged rule",
				severity: "warning",
				enabled: true,
				serviceNames: ["checkout"],
				signalType: "error_rate",
				comparator: "gt",
				threshold: 5,
				windowMinutes: 5,
				minimumSampleCount: 10,
				consecutiveBreachesRequired: 2,
				consecutiveHealthyRequired: 2,
				renotifyIntervalMinutes: 30,
				destinationIds: [destination.id],
			} as const

			// Tags are trimmed, lowercased, and deduped (so "Prod" and " prod "
			// collapse to one group key) while preserving first-seen order.
			const created = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({ ...baseRule, tags: ["Prod", " payments ", "prod", ""] }),
			)
			assert.deepStrictEqual(created.tags, ["prod", "payments"])

			// The normalized tags survive a round-trip through the persisted row.
			const afterCreate = yield* alerts.listRules(orgId)
			assert.deepStrictEqual(afterCreate.rules[0]?.tags, ["prod", "payments"])

			// Clearing tags on update persists an empty list, not the prior value.
			const updated = yield* alerts.updateRule(
				orgId,
				userId,
				adminRoles,
				created.id,
				new AlertRuleUpsertRequest({ ...baseRule, tags: [] }),
			)
			assert.deepStrictEqual(updated.tags, [])

			const afterClear = yield* alerts.listRules(orgId)
			assert.deepStrictEqual(afterClear.rules[0]?.tags, [])
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("opens per-service incidents for multi-service rules", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				tracesRow({
					count: 200,
					avgDuration: 40,
					p50Duration: 20,
					p95Duration: 120,
					p99Duration: 240,
					errorRate: 10,
					satisfiedCount: 180,
					toleratingCount: 10,
					apdexScore: 0.925,
				}),
			],
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_multi_svc")
			const userId = asUserId("user_multi_svc")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Multi-service error rate",
					severity: "critical",
					enabled: true,
					serviceNames: ["svc-a", "svc-b"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 2)
			const groupKeys = incidents.incidents.map((i: { groupKey: string | null }) => i.groupKey).sort()
			assert.deepStrictEqual(groupKeys, ["svc-a", "svc-b"])
			assert.isTrue(incidents.incidents.every((i: { status: string }) => i.status === "open"))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("opens per-service incidents for groupBy=service rules", () => {
		const testDb = createTestDb(trackedDbs)

		const breachingRow = tracesRow({
			groupName: "svc-breach",
			count: 200,
			avgDuration: 40,
			p50Duration: 20,
			p95Duration: 120,
			p99Duration: 240,
			errorRate: 10,
			satisfiedCount: 180,
			toleratingCount: 10,
			apdexScore: 0.925,
			estimatedSpanCount: 200,
		})
		const healthyRow = tracesRow({
			groupName: "svc-healthy",
			count: 200,
			avgDuration: 20,
			p50Duration: 10,
			p95Duration: 80,
			p99Duration: 160,
			errorRate: 0.5,
			satisfiedCount: 195,
			toleratingCount: 3,
			apdexScore: 0.9825,
			estimatedSpanCount: 200,
		})

		const alertRows: ReadonlyArray<Record<string, unknown>> = [breachingRow, healthyRow]
		const stub: WarehouseQueryServiceApi = {
			...makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }),
			sqlQuery: () => Effect.succeed(alertRows),
			compiledQuery: (_tenant, compiled) =>
				compiledQueryOf(compiled).decodeRows(alertRows).pipe(Effect.orDie),
			compiledQueryWithCapabilities: (_tenant, compile) =>
				Effect.runSync(compile(baselineWarehouseCapabilities()))
					.decodeRows(alertRows)
					.pipe(Effect.orDie),
			compiledQueryFirst: (_tenant, compiled) =>
				compiledQueryOf(compiled).decodeFirstRow(alertRows).pipe(Effect.orDie),
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_grouped")
			const userId = asUserId("user_grouped")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "All services error rate",
					severity: "critical",
					enabled: true,
					groupBy: ["service.name"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.groupKey, "svc-breach")
			assert.strictEqual(incidents.incidents[0]?.status, "open")
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	})
})
