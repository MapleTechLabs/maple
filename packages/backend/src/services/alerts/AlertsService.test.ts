import {
	AlertDeliveryError,
	AlertDeliveryRejectedError,
	type AlertEvaluationIntervalMinutes,
	AlertValidationError,
	WarehouseQuotaExceededError,
} from "@maple/domain/http"
import type { WarehouseQuerySettings } from "@maple/query-engine/profiles"
import { LiveActivitiesService } from "@maple/backend/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@maple/backend/services/push/MobileDevicesService"
import { ApnsClient } from "@maple/backend/platform/Apns"
import { MobilePushService } from "@maple/backend/services/push/MobilePushService"
import { ChatAlertPoster } from "./ChatAlertPoster"
// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Clock,
	ConfigProvider,
	Duration,
	Effect,
	Exit,
	HashMap,
	HashSet,
	Layer,
	Logger,
	Option,
	Order,
	Ref,
	Schema,
	Tracer,
} from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { projectAlertLifecycleEvent } from "@maple/alerting-core"
import {
	AlertDestinationInUseError,
	AlertForbiddenError,
	AlertRecipientSelectionError,
	type AlertDestinationId,
	AlertRulePreviewRequest,
	ChatConnectorId,
	ChatWorkspaceId,
	AlertRuleUpsertRequest,
	OrgId,
	WarehouseQueryError,
	WarehouseUpstreamError,
	RoleName,
	UserId,
} from "@maple/domain/http"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	AlertRuntime,
	type AlertRuntimeApi,
	AlertsService,
	type AlertsServiceApi,
	interleaveAlertRulesByOrg,
} from "./AlertsService"
import { AlertDestinationsService } from "./AlertDestinationsService"
import { AlertReadModelsService } from "./AlertReadModelsService"
import { AlertRulesService } from "./AlertRulesService"
import { BucketCacheService } from "@maple/query-engine/caching"
import { EdgeCacheService } from "@maple/cache"
import {
	baselineWarehouseCapabilities,
	formatWarehouseDateTime,
	isAlertRuleDue,
	snapAlertWindowEndMs,
} from "@maple/query-engine"
import { CacheBackendLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { HazelOAuthService } from "@maple/backend/services/auth/HazelOAuthService"
import { EmailService } from "@maple/backend/platform/EmailService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { OrgMembersService, type OrgMember } from "@maple/backend/services/org/OrgMembersService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { Database, DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { makeRecordingTracer, spansNamed } from "@maple/backend/testing/recording-tracer"
import { ChatSessions, type ChatSessionsApi } from "@maple/backend/platform/bindings"
import { fakeChatSessions } from "@maple/backend/platform/chat-sessions-fake"
import { IncidentClassifier } from "@maple/backend/services/errors/IncidentClassifier"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

describe("interleaveAlertRulesByOrg", () => {
	it("round-robins organizations while preserving per-org order", () => {
		const rows = [
			{ orgId: "a", id: "a1" },
			{ orgId: "a", id: "a2" },
			{ orgId: "a", id: "a3" },
			{ orgId: "b", id: "b1" },
			{ orgId: "b", id: "b2" },
			{ orgId: "c", id: "c1" },
		]
		assert.deepStrictEqual(
			interleaveAlertRulesByOrg(rows).map((row) => row.id),
			["a1", "b1", "c1", "a2", "b2", "a3"],
		)
	})
})

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined

	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure

	return Cause.squash(exit.cause)
}

const makeConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://maple-managed.tinybird.co",
			TINYBIRD_TOKEN: "managed-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
			MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
			MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
		}),
	)

const emptyWarehouseRows: ReadonlyArray<Record<string, unknown>> = []

/**
 * A complete `traces.timeseries` row.
 *
 * The queries derive their row schema from the SELECT now, so `decodeRows`
 * rejects a partial fixture instead of handing it through — which is the point:
 * every one of these fixtures was missing `bucket`, `groupName`, `spanCount`
 * and `estimatedSpanCount`, and none of them would have noticed the warehouse
 * dropping one.
 */
const tracesRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
	// The sample-count columns follow `count` unless a caller says otherwise:
	// `minimumSampleCount` reads them, so leaving them at 0 makes every rule
	// evaluate as "not enough data" no matter what the metric says.
	const count = overrides.count ?? 0
	return {
		// At the test clock, not a fixed calendar date: the evaluation window ends
		// at "now", so a bucket outside it reduces to no data and nothing fires.
		bucket: new Date(DEFAULT_CLOCK_EPOCH_MS).toISOString().replace("T", " ").slice(0, 19),
		groupName: "all",
		count: 0,
		spanCount: count,
		estimatedSpanCount: count,
		avgDuration: 0,
		p50Duration: 0,
		p95Duration: 0,
		p99Duration: 0,
		errorRate: 0,
		satisfiedCount: 0,
		toleratingCount: 0,
		apdexScore: 1,
		...overrides,
	}
}

function makeWarehouseStub(state: {
	tracesAggregateRows?: ReadonlyArray<Record<string, unknown>>
	metricsAggregateRows?: ReadonlyArray<Record<string, unknown>>
	logsAggregateRows?: ReadonlyArray<Record<string, unknown>>
	logsAggregateByServiceRows?: ReadonlyArray<Record<string, unknown>>
	rawQueryRows?: ReadonlyArray<Record<string, unknown>>
}): WarehouseQueryServiceApi {
	const succeedRows = (rows: ReadonlyArray<Record<string, unknown>>) => Effect.succeed(rows)

	// All alert queries now go through sqlQuery (raw SQL via CH query engine).
	// Route the response based on what data is configured in the test state.
	const sqlQueryStub = () => {
		// Return whichever data is configured — tests evaluate one rule type at a time
		if (state.rawQueryRows?.length) return succeedRows(state.rawQueryRows)
		if (state.logsAggregateByServiceRows?.length) return succeedRows(state.logsAggregateByServiceRows)
		if (state.tracesAggregateRows?.length) return succeedRows(state.tracesAggregateRows)
		if (state.metricsAggregateRows?.length) return succeedRows(state.metricsAggregateRows)
		if (state.logsAggregateRows?.length) return succeedRows(state.logsAggregateRows)
		return succeedRows(emptyWarehouseRows)
	}

	return {
		query: (_tenant, payload) => Effect.die(new Error(`Unexpected pipe ${payload.pipeName}`)),
		sqlQuery: sqlQueryStub,
		rawSqlQuery: sqlQueryStub,
		compiledQuery: (_tenant, compiled) =>
			sqlQueryStub().pipe(
				Effect.flatMap((rows) => compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)),
			),
		compiledQueryWithCapabilities: (_tenant, compile) =>
			sqlQueryStub().pipe(
				Effect.flatMap((rows) =>
					Effect.runSync(compile(baselineWarehouseCapabilities()))
						.decodeRows(rows)
						.pipe(Effect.orDie),
				),
			),
		compiledQueryFirst: (_tenant, compiled) =>
			sqlQueryStub().pipe(
				Effect.flatMap((rows) => compiledQueryOf(compiled).decodeFirstRow(rows).pipe(Effect.orDie)),
			),
		ingest: () => Effect.void,
		asExecutor: () => {
			throw new Error("asExecutor is not supported by this test stub")
		},
	}
}

const defaultTestRuntime: AlertRuntimeApi = {
	// Time is sourced from Effect's Clock, which `it.effect` swaps for TestClock —
	// scheduler-timestamp tests drive it deterministically via TestClock.setTime /
	// TestClock.adjust. Real `fetch`/`Effect.timeout` settle on the live event loop.
	now: Clock.currentTimeMillis,
	makeUuid: () => crypto.randomUUID(),
	deliveryTimeoutMs: () => 15_000,
	schedulerTickBudgetMs: () => 25_000,
	schedulerEvalTimeoutMs: () => 15_000,
	// Unpaced, so a tick runs as fast as its evaluations; the pacing tests opt in.
	schedulerSpreadMs: () => 0,
}

interface TestOverrides extends Partial<AlertRuntimeApi> {
	/** Provided as `FetchHttpClient.Fetch`, so every outbound call goes through it. */
	readonly fetch?: typeof fetch
	/** The investigation agent's port; absent means investigations cannot start. */
	readonly chatSessions?: ChatSessionsApi
}

// The fixed epoch scheduler tests start TestClock at, mirroring the previous
// manual clock's default start time.
const DEFAULT_CLOCK_EPOCH_MS = 1_700_000_000_000

const stubEmailService = (
	sent?: Array<{ to: string; subject: string; html: string }>,
): (typeof EmailService)["Service"] => ({
	isConfigured: true,
	send: (to, subject, html) =>
		Effect.sync(() => {
			sent?.push({ to, subject, html })
		}),
})

/** Fixed workspace-member directory the OrgMembersService stub resolves against. */
const TEST_ORG_MEMBERS: ReadonlyArray<OrgMember> = [
	{ userId: "user_ops", email: "ops@acme.test", name: "Ops Team" },
	{ userId: "user_oncall", email: "oncall@acme.test", name: null },
	{ userId: "user_lead", email: "lead@acme.test", name: "Lead" },
]

const stubOrgMembersService = (
	members: ReadonlyArray<OrgMember> = TEST_ORG_MEMBERS,
): (typeof OrgMembersService)["Service"] => ({
	resolveMembers: (_orgId, userIds) => {
		const byId = new Map(members.map((member) => [member.userId, member]))
		const resolved: Array<OrgMember> = []
		const unknown: Array<(typeof userIds)[number]> = []
		for (const userId of userIds) {
			const member = byId.get(userId)
			if (member === undefined) unknown.push(userId)
			else resolved.push(member)
		}
		return unknown.length > 0
			? Effect.fail(
					new AlertRecipientSelectionError({
						message: "Some selected users are not members of this workspace",
						unknownUserIds: unknown,
					}),
				)
			: Effect.succeed(resolved)
	},
})

const makeLayer = (
	testDb: TestDb,
	warehouseStub: WarehouseQueryServiceApi,
	overrides: TestOverrides = {},
	emailStub?: (typeof EmailService)["Service"],
	chatAlertPoster: Layer.Layer<ChatAlertPoster, never, Database | Env> = ChatAlertPoster.layer,
) => {
	const { fetch: fetchImpl = globalThis.fetch, chatSessions, ...runtimeOverrides } = overrides
	const configLive = makeConfig()
	const envLive = Env.layer.pipe(Layer.provide(configLive))
	const databaseLive = testDb.layer
	// Held only so the service can hand an autonomous investigation turn its `submit_diagnosis`
	// tool; no test here starts one. The real layer is cheap — it depends on nothing beyond Env
	// and the database already wired above.
	const investigationsLive = InvestigationService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, databaseLive)),
	)
	const warehouseLive = Layer.succeed(WarehouseQueryService, warehouseStub)
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))
	const bucketCacheLive = BucketCacheService.layer.pipe(Layer.provide(edgeCacheLive))
	const queryEngineLive = Layer.effect(QueryEngineService, QueryEngineService.make).pipe(
		Layer.provide(warehouseLive),
		Layer.provide(edgeCacheLive),
		Layer.provide(bucketCacheLive),
		Layer.provide(configLive),
	)
	const runtimeLive = Layer.succeed(AlertRuntime, { ...defaultTestRuntime, ...runtimeOverrides })
	const hazelOAuthLive = HazelOAuthService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, databaseLive)))
	const emailLive = Layer.succeed(EmailService, emailStub ?? stubEmailService())
	const orgMembersLive = Layer.succeed(OrgMembersService, stubOrgMembersService())
	const orgChSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, databaseLive, edgeCacheLive)),
	)
	const alertDestinationsLive = Layer.effect(AlertDestinationsService, AlertDestinationsService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(chatAlertPoster),
		Layer.provide(
			Layer.mergeAll(envLive, databaseLive, runtimeLive, hazelOAuthLive, emailLive, orgMembersLive),
		),
	)
	const alertReadModelsLive = Layer.effect(AlertReadModelsService, AlertReadModelsService.make).pipe(
		Layer.provide(Layer.mergeAll(databaseLive, warehouseLive)),
	)
	const alertRulesLive = AlertRulesService.layer.pipe(
		Layer.provide(Layer.mergeAll(databaseLive, runtimeLive)),
	)

	const alertsLive = Layer.effect(AlertsService, AlertsService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(chatAlertPoster),
		Layer.provide(
			Layer.effect(MobilePushService, MobilePushService.make).pipe(
				Layer.provide(
					Layer.mergeAll(ApnsClient.layer, MobileDevicesService.layer, LiveActivitiesService.layer),
				),
			),
		),
		Layer.provide(envLive),
		Layer.provide(databaseLive),
		Layer.provide(queryEngineLive),
		Layer.provide(warehouseLive),
		Layer.provide(runtimeLive),
		Layer.provide(hazelOAuthLive),
		Layer.provide(emailLive),
		Layer.provide(orgMembersLive),
		Layer.provide(orgChSettingsLive),
		Layer.provide(investigationsLive),
		Layer.provide(alertDestinationsLive),
		Layer.provide(alertReadModelsLive),
		Layer.provide(alertRulesLive),
		Layer.provide(chatSessions === undefined ? Layer.empty : Layer.succeed(ChatSessions, chatSessions)),
	)
	return Layer.mergeAll(alertDestinationsLive, alertReadModelsLive, alertRulesLive, alertsLive).pipe(
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
	)
}

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRoleName = Schema.decodeUnknownSync(RoleName)

const adminRoles = [asRoleName("root")]
const memberRoles = [asRoleName("org:member")]

const createWebhookDestination = (
	alerts: AlertsServiceApi,
	orgId: ReturnType<typeof asOrgId>,
	userId: ReturnType<typeof asUserId>,
) =>
	alerts.createDestination(orgId, userId, adminRoles, {
		type: "webhook",
		name: "Primary webhook",
		enabled: true,
		url: "https://example.com/maple-alerts",
		signingSecret: "webhook-secret",
	})

const createErrorRateRule = (
	alerts: AlertsServiceApi,
	orgId: ReturnType<typeof asOrgId>,
	userId: ReturnType<typeof asUserId>,
	destinationId: AlertDestinationId,
	// Callers that create SEVERAL rules in one org must vary this: alert_rules
	// carries a unique index on (org_id, name).
	name = "Checkout error rate",
) =>
	alerts.createRule(
		orgId,
		userId,
		adminRoles,
		new AlertRuleUpsertRequest({
			name,
			severity: "critical",
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
			destinationIds: [destinationId],
		}),
	)

const makeUuidSequence = (...values: string[]): Pick<AlertRuntimeApi, "makeUuid"> => {
	let index = 0
	return {
		makeUuid: () => values[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
	}
}

const okFetch: typeof fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch

const insertDeliveryEventRow = async (
	db: TestDb,
	row: {
		id: string
		orgId: string
		incidentId: string | null
		ruleId: string
		destinationId: string
		deliveryKey: string
		eventType: string
		attemptNumber: number
		status: string
		scheduledAt: number
		payloadJson: string
		createdAt?: number
		updatedAt?: number
	},
) => {
	await executeSql(
		db,
		`
      insert into alert_delivery_events (
        id,
        org_id,
        incident_id,
        rule_id,
        destination_id,
        delivery_key,
        event_type,
        attempt_number,
        status,
        scheduled_at,
        claimed_at,
        claim_expires_at,
        claimed_by,
        attempted_at,
        provider_message,
        provider_reference,
        response_code,
        error_message,
        payload_json,
        created_at,
        updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null, null, null, null, null, null, null, null, $11::jsonb, $12, $13)
    `,
		[
			row.id,
			row.orgId,
			row.incidentId,
			row.ruleId,
			row.destinationId,
			row.deliveryKey,
			row.eventType,
			row.attemptNumber,
			row.status,
			new Date(row.scheduledAt),
			row.payloadJson,
			new Date(row.createdAt ?? row.scheduledAt),
			new Date(row.updatedAt ?? row.scheduledAt),
		],
	)
}

describe("AlertsService", () => {
	it.effect("caps active alert rules per organization", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_active_rule_cap")
			const userId = asUserId("user_active_rule_cap")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const createRule = (index: number) =>
				alerts.createRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: `Capped rule ${index}`,
						severity: "warning",
						enabled: true,
						signalType: "error_rate",
						comparator: "gt",
						threshold: 5,
						windowMinutes: 5,
						destinationIds: [destination.id],
					}),
				)
			yield* Effect.forEach(
				Array.from({ length: 99 }, (_, index) => index),
				createRule,
				{ concurrency: 1, discard: true },
			)

			const exits = yield* Effect.all(
				[createRule(99).pipe(Effect.exit), createRule(100).pipe(Effect.exit)],
				{
					concurrency: "unbounded",
				},
			)
			assert.strictEqual(exits.filter(Exit.isSuccess).length, 1)
			assert.strictEqual(exits.filter(Exit.isFailure).length, 1)
			const error = getError(exits.find(Exit.isFailure)!)
			assert.instanceOf(error, AlertValidationError)
			assert.include((error as AlertValidationError).message, "at most 100 active alert rules")
			const rules = yield* alerts.listRules(orgId)
			assert.lengthOf(
				rules.rules.filter((rule) => rule.enabled),
				100,
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	it.effect("opens an incident after consecutive breaches and delivers the webhook notification", () => {
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
		const requests: Array<{ url: string; headers: Headers }> = []
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
			})
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alerts")
			const userId = asUserId("user_alerts")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			const incidentsAfterFirstTick = yield* alerts.listIncidents(orgId)

			// Advance past the scheduler lock TTL so the rule can be claimed again.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const incidentsAfterSecondTick = yield* alerts.listIncidents(orgId)
			const retrievedIncident = yield* alerts.getIncident(
				orgId,
				incidentsAfterSecondTick.incidents[0]!.id,
			)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidentsAfterFirstTick.incidents, 0)
			assert.lengthOf(incidentsAfterSecondTick.incidents, 1)
			assert.strictEqual(incidentsAfterSecondTick.incidents[0]?.status, "open")
			assert.strictEqual(retrievedIncident.id, incidentsAfterSecondTick.incidents[0]?.id)
			assert.lengthOf(events.events, 1)
			assert.strictEqual(events.events[0]?.status, "success")
			assert.strictEqual(events.events[0]?.eventType, "trigger")
			assert.lengthOf(requests, 1)
			assert.strictEqual(requests[0]?.url, "https://example.com/maple-alerts")
			assert.isNotEmpty(requests[0]?.headers.get("x-maple-signature") ?? "")
			assert.strictEqual(requests[0]?.headers.get("x-maple-event-type"), "trigger")
			assert.strictEqual(
				requests[0]?.headers.get("x-maple-delivery-key"),
				events.events[0]?.deliveryKey,
			)
			assert.notStrictEqual(
				requests[0]?.headers.get("x-maple-delivery-key"),
				incidentsAfterSecondTick.incidents[0]?.dedupeKey,
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
	})

	it.effect("never opens an incident whose trigger delivery could not be queued", () => {
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
		const requests: Array<string> = []
		const fetchImpl = (async (input: RequestInfo | URL) => {
			requests.push(String(input))
			return new Response("ok", { status: 200 })
		}) as typeof fetch
		const sql = (statement: string) => Effect.promise(() => executeSql(testDb, statement))

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alerts_outbox")
			const userId = asUserId("user_alerts_outbox")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			// The tick that opens the incident cannot queue its delivery.
			yield* sql(
				"CREATE FUNCTION refuse_delivery() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'delivery insert refused'; END $$ LANGUAGE plpgsql",
			)
			yield* sql(
				"CREATE TRIGGER refuse_delivery BEFORE INSERT ON alert_delivery_events FOR EACH ROW EXECUTE FUNCTION refuse_delivery()",
			)
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)

			yield* sql("DROP TRIGGER refuse_delivery ON alert_delivery_events")
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.strictEqual(incidents.incidents[0]?.status, "open")
			assert.deepStrictEqual(
				events.events.map((event) => [event.eventType, event.status]),
				[["trigger", "success"]],
			)
			assert.deepStrictEqual(requests, ["https://example.com/maple-alerts"])
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
	})

	it.effect("a rule disabled while a tick evaluates it neither opens an incident nor pages", () => {
		const testDb = createTestDb(trackedDbs)
		const base = makeWarehouseStub({
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
		})
		// Runs before the next warehouse read, once; set when the edit should land.
		let beforeQuery: Effect.Effect<void> = Effect.void
		const hooked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.suspend(() => {
				const hook = beforeQuery
				beforeQuery = Effect.void
				return Effect.andThen(hook, effect)
			})
		const stub: WarehouseQueryServiceApi = {
			...base,
			sqlQuery: (...args) => hooked(base.sqlQuery(...args)),
			rawSqlQuery: (...args) => hooked(base.rawSqlQuery(...args)),
			compiledQuery: (...args) => hooked(base.compiledQuery(...args)),
			compiledQueryWithCapabilities: (...args) => hooked(base.compiledQueryWithCapabilities(...args)),
			compiledQueryFirst: (...args) => hooked(base.compiledQueryFirst(...args)),
		}
		const requests: Array<string> = []
		const fetchImpl = (async (input: RequestInfo | URL) => {
			requests.push(String(input))
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alerts_edit_fence")
			const userId = asUserId("user_alerts_edit_fence")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			// The tick that would open the incident reads the warehouse after
			// claiming the rule; the rule is disabled in between. The claim is then
			// put back at this tick's time, as a tick still holding the pre-edit
			// snapshot would when it claims the rule afresh.
			const tickAt = DEFAULT_CLOCK_EPOCH_MS + 60_000
			beforeQuery = alerts
				.updateRule(
					orgId,
					userId,
					adminRoles,
					rule.id,
					new AlertRuleUpsertRequest({
						name: rule.name,
						severity: "critical",
						enabled: false,
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
					}),
				)
				.pipe(
					Effect.orDie,
					Effect.andThen(
						Effect.promise(() =>
							executeSql(
								testDb,
								"insert into alert_rule_claims (rule_id, org_id, last_scheduled_at) values ($1, $2, $3) on conflict (rule_id) do update set last_scheduled_at = excluded.last_scheduled_at",
								[rule.id, orgId, new Date(tickAt).toISOString()],
							),
						),
					),
					Effect.asVoid,
				)
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
			assert.lengthOf((yield* alerts.listDeliveryEvents(orgId)).events, 0)
			assert.deepStrictEqual(requests, [])
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: fetchImpl })))
	})

	it.effect("snapshots a custom notification template into the delivered payload", () => {
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
		const bodies: string[] = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(typeof init?.body === "string" ? init.body : "")
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_tpl")
			const userId = asUserId("user_tpl")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Checkout error rate",
					severity: "critical",
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
					notificationTemplate: {
						title: "{{ severity }} on {{ rule.name }}",
						body: "*Observed:* {{ observed.summary }}",
					},
				}),
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			// The custom template is re-read from the rule and surfaces through
			// get_alert_rule / listRules.
			const rules = yield* alerts.listRules(orgId)
			assert.strictEqual(
				rules.rules[0]?.notificationTemplate?.title,
				"{{ severity }} on {{ rule.name }}",
			)

			// The webhook body is the snapshotted delivery payload — it carries the
			// template so retries and downstream consumers render the same message.
			assert.lengthOf(bodies, 1)
			const payload = JSON.parse(bodies[0]!) as {
				template?: { title?: string; body?: string }
			}
			assert.strictEqual(payload.template?.title, "{{ severity }} on {{ rule.name }}")
			assert.strictEqual(payload.template?.body, "*Observed:* {{ observed.summary }}")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
	})

	it.effect("skips no-data error-rate rules instead of opening incidents", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: emptyWarehouseRows,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_skipped")
			const userId = asUserId("user_skipped")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidents.incidents, 0)
			assert.lengthOf(events.events, 0)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state))))
	})

	it.effect("treats no data as a breach for throughput-below-threshold rules", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: emptyWarehouseRows,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_throughput")
			const userId = asUserId("user_throughput")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Zero throughput",
					severity: "warning",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "throughput",
					comparator: "lt",
					threshold: 1,
					windowMinutes: 5,
					minimumSampleCount: 0,
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
			assert.strictEqual(incidents.incidents[0]?.status, "open")
			assert.strictEqual(incidents.incidents[0]?.signalType, "throughput")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("persists compiled query plans when rules are created", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_compiled_plan")
			const userId = asUserId("user_compiled_plan")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					querySpecJson: unknown
					reducer: string
					sampleCountStrategy: string
					noDataBehavior: string
				}>(
					testDb,
					`
        select query_spec_json as "querySpecJson", reducer, sample_count_strategy as "sampleCountStrategy", no_data_behavior as "noDataBehavior"
        from alert_rules
        limit 1
      `,
				),
			)

			assert.isOk(row)
			assert.strictEqual(row?.reducer, "identity")
			assert.strictEqual(row?.sampleCountStrategy, "trace_count")
			assert.strictEqual(row?.noDataBehavior, "skip")
			const spec = row?.querySpecJson as {
				kind: string
				source: string
				metric: string
				groupBy: ReadonlyArray<string>
				filters: { serviceName: string }
			}
			assert.strictEqual(spec.kind, "timeseries")
			assert.strictEqual(spec.source, "traces")
			assert.strictEqual(spec.metric, "error_rate")
			assert.deepStrictEqual(spec.groupBy, ["none"])
			assert.strictEqual(spec.filters.serviceName, "checkout")
			// No environment scope selected → the filter must be absent entirely, not
			// an empty array (which the CH lowering would still treat as "no rows").
			assert.isUndefined((spec.filters as { environments?: unknown }).environments)
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("holds the scheduler claim outside alert_rules and heartbeats the rule row", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_claim_lock")
			const userId = asUserId("user_claim_lock")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			const claimAt = () =>
				Effect.promise(() =>
					queryFirstRow<{ lastScheduledAt: Date | null }>(
						testDb,
						`select last_scheduled_at as "lastScheduledAt" from alert_rule_claims limit 1`,
					),
				)
			const ruleScheduledAt = () =>
				Effect.promise(() =>
					queryFirstRow<{ lastScheduledAt: Date | null }>(
						testDb,
						`select last_scheduled_at as "lastScheduledAt" from alert_rules limit 1`,
					),
				)

			yield* alerts.runSchedulerTick()
			const claimFirst = yield* claimAt()
			const ruleFirst = yield* ruleScheduledAt()

			// One minute on: the claim must advance (it is the actual per-tick lock)
			// while alert_rules must NOT, because it is Electric-synced and every write
			// to it is replicated out of PlanetScale. That divergence is the whole point
			// of splitting the lock out — if these two move together, the WAL churn the
			// split was meant to remove is back.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const claimSecond = yield* claimAt()
			const ruleSecond = yield* ruleScheduledAt()

			// Past the 5-minute heartbeat the rule row catches up, so the column stays
			// meaningful for the API and the web diagnosis panel.
			yield* TestClock.adjust(Duration.minutes(6))
			yield* alerts.runSchedulerTick()
			const ruleThird = yield* ruleScheduledAt()

			assert.isOk(claimFirst?.lastScheduledAt, "claim row is created on the first tick")
			assert.isAbove(
				claimSecond!.lastScheduledAt!.getTime(),
				claimFirst!.lastScheduledAt!.getTime(),
				"claim advances every tick",
			)
			assert.strictEqual(
				ruleSecond?.lastScheduledAt?.getTime(),
				ruleFirst?.lastScheduledAt?.getTime(),
				"alert_rules is not rewritten inside the heartbeat window",
			)
			assert.isAbove(
				ruleThird!.lastScheduledAt!.getTime(),
				ruleFirst!.lastScheduledAt!.getTime(),
				"alert_rules catches up once the heartbeat window elapses",
			)
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	// Rules are claimed a chunk at a time in ONE multi-row INSERT, so the whole
	// batch rides on `setWhere` gating each row independently. If it ever gated the
	// statement instead, one rule already held by another worker would either drag
	// its whole chunk down or — worse — hand every rule in the chunk a claim it did
	// not win, and two workers would evaluate the same rules concurrently.
	it.effect("claims only the unheld rules when a chunk contains one another worker holds", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_batch_claim")
			const userId = asUserId("user_batch_claim")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const ruleA = yield* createErrorRateRule(alerts, orgId, userId, destination.id, "rule A")
			const ruleHeld = yield* createErrorRateRule(alerts, orgId, userId, destination.id, "rule held")
			const ruleC = yield* createErrorRateRule(alerts, orgId, userId, destination.id, "rule C")

			// Another worker took this one moments ago: inside SCHEDULER_LOCK_TTL_MS,
			// so this tick must lose it and leave its timestamp untouched.
			const heldAt = new Date(DEFAULT_CLOCK_EPOCH_MS - 1_000)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`insert into alert_rule_claims (rule_id, org_id, last_scheduled_at) values ($1, $2, $3)`,
					[ruleHeld.id, orgId, heldAt],
				),
			)

			yield* alerts.runSchedulerTick()

			const claimFor = (ruleId: string) =>
				Effect.promise(() =>
					queryFirstRow<{ lastScheduledAt: Date | null }>(
						testDb,
						`select last_scheduled_at as "lastScheduledAt" from alert_rule_claims where rule_id = $1`,
						[ruleId],
					),
				)

			const claimA = yield* claimFor(ruleA.id)
			const claimHeld = yield* claimFor(ruleHeld.id)
			const claimC = yield* claimFor(ruleC.id)

			// The two free rules are claimed by this tick...
			assert.strictEqual(
				claimA?.lastScheduledAt?.getTime(),
				DEFAULT_CLOCK_EPOCH_MS,
				"an unheld rule in the batch is claimed",
			)
			assert.strictEqual(
				claimC?.lastScheduledAt?.getTime(),
				DEFAULT_CLOCK_EPOCH_MS,
				"every unheld rule in the batch is claimed, not just the first",
			)
			// ...while the held one keeps the other worker's timestamp exactly.
			assert.strictEqual(
				claimHeld?.lastScheduledAt?.getTime(),
				heldAt.getTime(),
				"a rule held inside the lock TTL is not stolen by the batch",
			)
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("lowers the environment scope into a built-in signal's compiled plan", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_env_scope")
			const userId = asUserId("user_env_scope")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Checkout error rate (prod)",
					severity: "critical",
					serviceNames: ["checkout"],
					// Duplicates and whitespace are normalized away on write.
					environments: ["production", " staging ", "production"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					destinationIds: [destination.id],
				}),
			)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ querySpecJson: unknown; environmentsJson: unknown }>(
					testDb,
					`select query_spec_json as "querySpecJson", environments_json as "environmentsJson"
					 from alert_rules limit 1`,
				),
			)

			assert.deepStrictEqual(row?.environmentsJson, ["production", "staging"])
			const spec = row?.querySpecJson as { filters: { environments: ReadonlyArray<string> } }
			assert.deepStrictEqual(spec.filters.environments, ["production", "staging"])

			const rules = yield* alerts.listRules(orgId)
			assert.deepStrictEqual([...(rules.rules[0]?.environments ?? [])], ["production", "staging"])
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("drops the environment scope for builder_query rules", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_env_builder")
			const userId = asUserId("user_env_builder")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			// A builder_query draft already expresses environment in its where clause;
			// a second rule-level predicate would silently AND onto the user's query.
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Custom query",
					severity: "warning",
					environments: ["production"],
					signalType: "builder_query",
					queryBuilderDraft: {
						id: "alert-query",
						name: "A",
						dataSource: "traces",
						aggregation: "count",
						whereClause: "",
						groupBy: [],
					},
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					destinationIds: [destination.id],
				}),
			)

			assert.deepStrictEqual([...rule.environments], [])
		}).pipe(
			Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }))),
		)
	})

	it.effect("resolves an open incident after consecutive healthy evaluations", () => {
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
			] as ReadonlyArray<Record<string, unknown>>,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_resolve")
			const userId = asUserId("user_resolve")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			state.tracesAggregateRows = [
				tracesRow({
					count: 200,
					avgDuration: 20,
					p50Duration: 10,
					p95Duration: 80,
					p99Duration: 160,
					errorRate: 0.5,
					satisfiedCount: 195,
					toleratingCount: 3,
					apdexScore: 0.9825,
				}),
			]

			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.status, "resolved")
			assert.deepStrictEqual(
				events.events.map((event: { eventType: string }) => event.eventType),
				["resolve", "trigger"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	describe("severity tiers", () => {
		const errorRateRows = (errorRate: number) => [
			tracesRow({
				count: 200,
				avgDuration: 40,
				p50Duration: 20,
				p95Duration: 120,
				p99Duration: 240,
				errorRate,
				satisfiedCount: 180,
				toleratingCount: 10,
				apdexScore: 0.925,
			}),
		]

		const createTieredSetup = (alerts: AlertsServiceApi, orgId: OrgId, userId: UserId) =>
			Effect.gen(function* () {
				const warnHook = yield* alerts.createDestination(orgId, userId, adminRoles, {
					type: "webhook",
					name: "Team channel",
					enabled: true,
					url: "https://example.com/warn",
					signingSecret: "warn-secret",
				})
				const pageHook = yield* alerts.createDestination(orgId, userId, adminRoles, {
					type: "webhook",
					name: "Pager",
					enabled: true,
					url: "https://example.com/page",
					signingSecret: "page-secret",
				})
				const rule = yield* alerts.createRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: "Checkout error rate tiers",
						enabled: true,
						serviceNames: ["checkout"],
						signalType: "error_rate",
						comparator: "gt",
						thresholds: [
							{
								severity: "critical",
								value: 20,
								upper: null,
								recoveryValue: null,
								destinationIds: [pageHook.id],
							},
							{
								severity: "warning",
								value: 5,
								upper: null,
								recoveryValue: null,
								destinationIds: [warnHook.id],
							},
						],
						windowMinutes: 5,
						minimumSampleCount: 10,
						consecutiveBreachesRequired: 2,
						consecutiveHealthyRequired: 2,
						renotifyIntervalMinutes: 30,
					}),
				)
				return { warnHook, pageHook, rule }
			})

		it.effect("opens at warning, pages on escalation, and resolves to everyone it notified", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
			const requests: Array<{ url: string; eventType: string | null }> = []
			const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push({
					url: String(input),
					eventType: new Headers(init?.headers).get("x-maple-event-type"),
				})
				return new Response("ok", { status: 200 })
			}) as typeof fetch

			const tick = (alerts: AlertsServiceApi) =>
				Effect.gen(function* () {
					yield* TestClock.adjust(Duration.minutes(1))
					yield* alerts.runSchedulerTick()
				})

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers")
				const userId = asUserId("user_tiers")
				const { rule } = yield* createTieredSetup(alerts, orgId, userId)

				// Stored lowest tier first; the single-threshold fields mirror it.
				assert.deepStrictEqual(
					rule.thresholds.map((tier) => tier.severity),
					["warning", "critical"],
				)
				assert.strictEqual(rule.severity, "critical")
				assert.strictEqual(rule.threshold, 5)

				yield* alerts.runSchedulerTick()
				yield* tick(alerts)
				const opened = (yield* alerts.listIncidents(orgId)).incidents[0]
				assert.strictEqual(opened?.severity, "warning")
				assert.deepStrictEqual(requests, [{ url: "https://example.com/warn", eventType: "trigger" }])

				state.tracesAggregateRows = errorRateRows(30)
				yield* tick(alerts)
				yield* tick(alerts)
				const escalated = (yield* alerts.listIncidents(orgId)).incidents[0]
				assert.strictEqual(escalated?.id, opened?.id)
				assert.strictEqual(escalated?.severity, "critical")
				assert.strictEqual(escalated?.peakSeverity, "critical")
				assert.strictEqual(escalated?.threshold, 20)
				// The linked issue follows the escalation while the detector owns its severity.
				const issues = yield* Effect.promise(() =>
					testDb.pglite.query<{ severity: string }>(
						"select severity from error_issues where org_id = $1 and kind = 'alert'",
						[orgId],
					),
				)
				assert.deepStrictEqual(
					issues.rows.map((issue) => issue.severity),
					["critical"],
				)
				assert.sameMembers(
					requests.slice(1).map((request) => `${request.eventType} ${request.url}`),
					["trigger https://example.com/warn", "trigger https://example.com/page"],
				)

				state.tracesAggregateRows = errorRateRows(0.5)
				yield* tick(alerts)
				yield* tick(alerts)
				const resolved = (yield* alerts.listIncidents(orgId)).incidents[0]
				assert.strictEqual(resolved?.status, "resolved")
				assert.sameMembers(
					requests.slice(3).map((request) => `${request.eventType} ${request.url}`),
					["resolve https://example.com/warn", "resolve https://example.com/page"],
				)
			}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: fetchImpl })))
		})

		const recordingFetch = (requests: Array<string>) =>
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(`${new Headers(init?.headers).get("x-maple-event-type")} ${String(input)}`)
				return new Response("ok", { status: 200 })
			}) as typeof fetch

		it.effect("reminds only the current tier after a de-escalation", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(30) as ReadonlyArray<Record<string, unknown>> }
			const requests: Array<string> = []
			const tick = (alerts: AlertsServiceApi, minutes = 1) =>
				Effect.gen(function* () {
					yield* TestClock.adjust(Duration.minutes(minutes))
					yield* alerts.runSchedulerTick()
				})

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_remind")
				yield* createTieredSetup(alerts, orgId, asUserId("user_tiers_remind"))

				yield* alerts.runSchedulerTick()
				yield* tick(alerts)
				assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.severity, "critical")

				state.tracesAggregateRows = errorRateRows(10)
				yield* tick(alerts)
				yield* tick(alerts)
				const deescalated = (yield* alerts.listIncidents(orgId)).incidents[0]
				assert.strictEqual(deescalated?.severity, "warning")
				assert.strictEqual(deescalated?.peakSeverity, "critical")
				// The pager that heard the critical hears it calm down.
				assert.sameMembers(requests.slice(2), [
					"renotify https://example.com/warn",
					"renotify https://example.com/page",
				])

				yield* tick(alerts, 31)
				assert.deepStrictEqual(requests.slice(4), ["renotify https://example.com/warn"])
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) }),
				),
			)
		})

		it.effect("resolves a warning incident ended by a rule edit without paging", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
			const requests: Array<string> = []

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_edit")
				const userId = asUserId("user_tiers_edit")
				const { rule } = yield* createTieredSetup(alerts, orgId, userId)

				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				assert.deepStrictEqual(requests, ["trigger https://example.com/warn"])

				yield* alerts.updateRule(
					orgId,
					userId,
					adminRoles,
					rule.id,
					new AlertRuleUpsertRequest({
						name: rule.name,
						enabled: false,
						serviceNames: [...rule.serviceNames],
						signalType: rule.signalType,
						comparator: rule.comparator,
						thresholds: rule.thresholds,
						windowMinutes: rule.windowMinutes,
						minimumSampleCount: rule.minimumSampleCount,
						consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
						consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
						renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
					}),
				)
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
				assert.deepStrictEqual(requests.slice(1), ["resolve https://example.com/warn"])
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) }),
				),
			)
		})

		it.effect("resolves to the remaining tier after the incident's tier is removed", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
			const requests: Array<string> = []
			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_removed")
				const userId = asUserId("user_tiers_removed")
				const { rule, pageHook } = yield* createTieredSetup(alerts, orgId, userId)
				const tick = Effect.gen(function* () {
					yield* TestClock.adjust(Duration.minutes(1))
					yield* alerts.runSchedulerTick()
				})

				yield* alerts.runSchedulerTick()
				yield* tick
				assert.deepStrictEqual(requests, ["trigger https://example.com/warn"])

				yield* alerts.updateRule(
					orgId,
					userId,
					adminRoles,
					rule.id,
					new AlertRuleUpsertRequest({
						name: rule.name,
						serviceNames: [...rule.serviceNames],
						signalType: rule.signalType,
						comparator: rule.comparator,
						thresholds: [
							{
								severity: "critical",
								value: 20,
								upper: null,
								recoveryValue: null,
								destinationIds: [pageHook.id],
							},
						],
						windowMinutes: rule.windowMinutes,
						minimumSampleCount: rule.minimumSampleCount,
						consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
						consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
						renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
					}),
				)
				state.tracesAggregateRows = errorRateRows(0.5)
				yield* tick
				yield* tick
				assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
				// The remaining tier's pager, and the webhook that heard the trigger.
				assert.sameMembers(requests.slice(1), [
					"resolve https://example.com/page",
					"resolve https://example.com/warn",
				])
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) }),
				),
			)
		})

		it.effect("resolves to a destination an edit removed after it was paged", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(30) as ReadonlyArray<Record<string, unknown>> }
			const requests: Array<string> = []

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_removed_dest")
				const userId = asUserId("user_tiers_removed_dest")
				const { rule, warnHook } = yield* createTieredSetup(alerts, orgId, userId)

				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				assert.sameMembers(requests, [
					"trigger https://example.com/warn",
					"trigger https://example.com/page",
				])

				// Same condition, but the critical tier no longer pages the pager.
				yield* alerts.updateRule(
					orgId,
					userId,
					adminRoles,
					rule.id,
					new AlertRuleUpsertRequest({
						name: rule.name,
						enabled: true,
						serviceNames: [...rule.serviceNames],
						signalType: rule.signalType,
						comparator: rule.comparator,
						thresholds: [
							rule.thresholds[0],
							{ ...rule.thresholds[1]!, destinationIds: [warnHook.id] },
						],
						windowMinutes: rule.windowMinutes,
						minimumSampleCount: rule.minimumSampleCount,
						consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
						consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
						renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
					}),
				)

				state.tracesAggregateRows = errorRateRows(0.5)
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
				assert.include(requests, "resolve https://example.com/page")
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub(state), { fetch: recordingFetch(requests) }),
				),
			)
		})

		it.effect("keeps counting ticks across an edit that leaves the condition alone", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_rename")
				const userId = asUserId("user_tiers_rename")
				const { rule } = yield* createTieredSetup(alerts, orgId, userId)

				yield* alerts.runSchedulerTick()
				yield* alerts.updateRule(
					orgId,
					userId,
					adminRoles,
					rule.id,
					new AlertRuleUpsertRequest({
						name: "Renamed",
						serviceNames: [...rule.serviceNames],
						signalType: rule.signalType,
						comparator: rule.comparator,
						thresholds: rule.thresholds,
						windowMinutes: rule.windowMinutes,
						minimumSampleCount: rule.minimumSampleCount,
						consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
						consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
						renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
					}),
				)
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
				// The breach before the rename still counts: two in a row open the incident.
				assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.severity, "warning")
			}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
		})

		it.effect("does not count ticks judged against an edited threshold", () => {
			const testDb = createTestDb(trackedDbs)
			const state = { tracesAggregateRows: errorRateRows(10) as ReadonlyArray<Record<string, unknown>> }
			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_edit_history")
				const userId = asUserId("user_tiers_edit_history")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const request = (value: number) =>
					new AlertRuleUpsertRequest({
						name: "Two of five",
						serviceNames: ["checkout"],
						signalType: "error_rate",
						comparator: "gt",
						thresholds: [
							{
								severity: "warning",
								value,
								upper: null,
								recoveryValue: null,
								destinationIds: [destination.id],
							},
						],
						windowMinutes: 5,
						minimumSampleCount: 10,
						consecutiveBreachesRequired: 2,
						breachesOutOf: 5,
					})
				const rule = yield* alerts.createRule(orgId, userId, adminRoles, request(5))
				const tick = Effect.gen(function* () {
					yield* TestClock.adjust(Duration.minutes(1))
					yield* alerts.runSchedulerTick()
				})

				// One breach, then a healthy tick, both against the old threshold of 5.
				yield* alerts.runSchedulerTick()
				state.tracesAggregateRows = errorRateRows(1)
				yield* tick
				yield* alerts.updateRule(orgId, userId, adminRoles, rule.id, request(15))

				// A single breach of the new threshold is one of five, not two.
				state.tracesAggregateRows = errorRateRows(30)
				yield* tick
				assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
				yield* tick
				assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 1)
			}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
		})

		it.effect(
			"records the critical tier's threshold on the issue of an incident that opens at critical",
			() => {
				const testDb = createTestDb(trackedDbs)
				const state = {
					tracesAggregateRows: errorRateRows(30) as ReadonlyArray<Record<string, unknown>>,
				}
				return Effect.gen(function* () {
					yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
					const alerts = yield* AlertsService
					const orgId = asOrgId("org_tiers_issue")
					yield* createTieredSetup(alerts, orgId, asUserId("user_tiers_issue"))

					yield* alerts.runSchedulerTick()
					yield* TestClock.adjust(Duration.minutes(1))
					yield* alerts.runSchedulerTick()

					const incident = (yield* alerts.listIncidents(orgId)).incidents[0]
					assert.strictEqual(incident?.severity, "critical")
					assert.strictEqual(incident?.threshold, 20)
					const issue = yield* Effect.promise(() =>
						queryFirstRow<{ exception_message: string }>(
							testDb,
							"select exception_message from error_issues where org_id = $1 and kind = 'alert'",
							[orgId],
						),
					)
					assert.include(issue?.exception_message ?? "", "gt 20")
				}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
			},
		)

		it.effect("rejects a critical threshold that is not worse than the warning one", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_tiers_invalid")
				const userId = asUserId("user_tiers_invalid")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const exit = yield* alerts
					.createRule(
						orgId,
						userId,
						adminRoles,
						new AlertRuleUpsertRequest({
							name: "Inverted tiers",
							signalType: "error_rate",
							comparator: "gt",
							thresholds: [
								{
									severity: "warning",
									value: 20,
									upper: null,
									recoveryValue: 25,
									destinationIds: [destination.id],
								},
								{
									severity: "critical",
									value: 5,
									upper: null,
									recoveryValue: null,
									destinationIds: [destination.id],
								},
							],
							windowMinutes: 5,
						}),
					)
					.pipe(Effect.exit)
				assert.isTrue(Exit.isFailure(exit))
				const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null
				assert.instanceOf(error, AlertValidationError)
				assert.includeMembers(error instanceof AlertValidationError ? [...error.details] : [], [
					"the critical threshold must be worse than the warning threshold",
					"thresholds[0].recoveryValue must be on the healthy side of thresholds[0].value",
				])
			}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: [] }))))
		})
	})

	it.effect("suppresses trigger and resolve notifications while an incident flaps", () => {
		const testDb = createTestDb(trackedDbs)
		const breachedRows = [
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
		] as ReadonlyArray<Record<string, unknown>>
		const healthyRows = [
			tracesRow({
				count: 200,
				avgDuration: 20,
				p50Duration: 10,
				p95Duration: 80,
				p99Duration: 160,
				errorRate: 0.5,
				satisfiedCount: 195,
				toleratingCount: 3,
				apdexScore: 0.9825,
			}),
		] as ReadonlyArray<Record<string, unknown>>
		const state = { tracesAggregateRows: breachedRows }

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_flap")
			const userId = asUserId("user_flap")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			const tick = Effect.gen(function* () {
				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
			})

			// Flap 1: open (trigger delivered) then resolve (resolve delivered).
			yield* tick
			yield* tick
			state.tracesAggregateRows = healthyRows
			yield* tick
			yield* tick

			// Flap 2 within the renotify interval: incident opens again, but both
			// its trigger and its resolve notifications are suppressed.
			state.tracesAggregateRows = breachedRows
			yield* tick
			yield* tick
			state.tracesAggregateRows = healthyRows
			yield* tick
			yield* tick

			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.lengthOf(incidents.incidents, 2)
			assert.isTrue(incidents.incidents.every((incident) => incident.status === "resolved"))
			// Only the first flap emailed: one trigger + one resolve, nothing for flap 2.
			assert.deepStrictEqual(
				events.events.map((event: { eventType: string }) => event.eventType).sort(),
				["resolve", "trigger"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("disabling a rule does not announce the all-clear of a flap-suppressed incident", () => {
		const testDb = createTestDb(trackedDbs)
		const row = (errorRate: number) =>
			tracesRow({
				count: 200,
				avgDuration: 20,
				p50Duration: 10,
				p95Duration: 80,
				p99Duration: 160,
				errorRate,
				satisfiedCount: 190,
				toleratingCount: 5,
				apdexScore: 0.96,
			})
		const state = { tracesAggregateRows: [row(10)] as ReadonlyArray<Record<string, unknown>> }

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_flap_disable")
			const userId = asUserId("user_flap_disable")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const ticks = (errorRate: number) =>
				Effect.sync(() => {
					state.tracesAggregateRows = [row(errorRate)]
				}).pipe(
					Effect.andThen(alerts.runSchedulerTick()),
					Effect.andThen(TestClock.adjust(Duration.minutes(1))),
					Effect.repeat({ times: 1 }),
				)

			// Flap 1 is announced; flap 2 reopens inside the renotify interval, so
			// its trigger is suppressed. Disabling the rule then resolves it.
			yield* ticks(10)
			yield* ticks(0.5)
			yield* ticks(10)
			yield* alerts.updateRule(
				orgId,
				userId,
				adminRoles,
				rule.id,
				new AlertRuleUpsertRequest({
					name: "Checkout error rate",
					severity: "critical",
					enabled: false,
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
				}),
			)

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 2)
			assert.isTrue(incidents.incidents.every((incident) => incident.status === "resolved"))
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.deepStrictEqual(
				events.events.map((event: { eventType: string }) => event.eventType).sort(),
				["resolve", "trigger"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("queues at most one renotify per interval while deliveries keep failing", () => {
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
			] as ReadonlyArray<Record<string, unknown>>,
		}
		const failingFetch: typeof fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_renotify_gate")
			const userId = asUserId("user_renotify_gate")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Checkout error rate",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 5,
					destinationIds: [destination.id],
				}),
			)

			// Trigger opens on the second tick; every delivery attempt fails with a
			// retryable 500 for the whole test, so lastNotifiedAt can only advance
			// via the queue-time gate.
			for (let minute = 0; minute < 9; minute += 1) {
				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
			}

			const events = yield* alerts.listDeliveryEvents(orgId)
			const renotifyFirstAttempts = events.events.filter(
				(event: { eventType: string; attemptNumber: number }) =>
					event.eventType === "renotify" && event.attemptNumber === 1,
			)
			// Trigger at t=1min → renotify due at t=6min. Ticks at 7/8 min must NOT
			// re-queue a fresh renotify chain even though nothing was delivered.
			assert.lengthOf(renotifyFirstAttempts, 1)

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.isNotNull(incidents.incidents[0]?.lastNotifiedAt)

			// One interval after the queue-time advance, a second renotify chain starts.
			for (let minute = 0; minute < 3; minute += 1) {
				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
			}
			const eventsAfter = yield* alerts.listDeliveryEvents(orgId)
			const renotifyChains = new Set(
				eventsAfter.events
					.filter((event: { eventType: string }) => event.eventType === "renotify")
					.map((event: { deliveryKey: string }) => event.deliveryKey.split(":").at(-1)),
			)
			assert.strictEqual(renotifyChains.size, 2)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: failingFetch })))
	})

	it.effect("skips unchanged alert_rule_states writes and refreshes on the 5-minute heartbeat", () => {
		const testDb = createTestDb(trackedDbs)
		// Healthy from the start: errorRate 1 stays below the threshold of 5.
		const state = {
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
			] as ReadonlyArray<Record<string, unknown>>,
		}

		const readState = (ruleId: string) =>
			Effect.promise(() =>
				queryFirstRow<{
					consecutive_healthy: number
					consecutive_breaches: number
					last_status: string | null
					last_evaluated_at: Date | string
					updated_at: Date | string
				}>(
					testDb,
					`select consecutive_healthy, consecutive_breaches, last_status, last_evaluated_at, updated_at
					 from alert_rule_states where rule_id = $1 and group_key = '__total__'`,
					[ruleId],
				),
			)
		const ms = (value: Date | string | undefined) => new Date(value ?? 0).getTime()

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_quiet")
			const userId = asUserId("user_state_quiet")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Tick 1 (T+0): healthy=1 → writes. Tick 2 (T+1m): healthy=2 (capped at
			// consecutiveHealthyRequired) → writes.
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterSecondTick = yield* readState(rule.id)
			assert.strictEqual(afterSecondTick?.consecutive_healthy, 2)
			assert.strictEqual(afterSecondTick?.last_status, "healthy")
			assert.strictEqual(ms(afterSecondTick?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)

			// Ticks at T+2m..T+5m: state unchanged and within the heartbeat window
			// (last write T+1m) → the upsert is skipped, the row stays byte-identical.
			for (let i = 0; i < 4; i++) {
				yield* TestClock.adjust(Duration.minutes(1))
				yield* alerts.runSchedulerTick()
			}
			const afterQuietTicks = yield* readState(rule.id)
			assert.strictEqual(afterQuietTicks?.consecutive_healthy, 2)
			assert.strictEqual(ms(afterQuietTicks?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)
			assert.strictEqual(ms(afterQuietTicks?.updated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)

			// Tick at T+6m: 5 minutes since the last write → heartbeat refreshes
			// last_evaluated_at without changing the state.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterHeartbeat = yield* readState(rule.id)
			assert.strictEqual(afterHeartbeat?.consecutive_healthy, 2)
			assert.strictEqual(afterHeartbeat?.last_status, "healthy")
			assert.strictEqual(ms(afterHeartbeat?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 6 * 60_000)

			// A transition writes immediately, even right after a heartbeat write:
			// flip the warehouse to breaching and tick at T+7m.
			state.tracesAggregateRows = [
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
			]
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterBreach = yield* readState(rule.id)
			assert.strictEqual(afterBreach?.last_status, "breached")
			assert.strictEqual(afterBreach?.consecutive_breaches, 1)
			assert.strictEqual(afterBreach?.consecutive_healthy, 0)
			assert.strictEqual(ms(afterBreach?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 7 * 60_000)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("caps the breach counter during an open incident while the incident row keeps updating", () => {
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
			] as ReadonlyArray<Record<string, unknown>>,
		}

		const ms = (value: Date | string | undefined) => new Date(value ?? 0).getTime()

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_cap")
			const userId = asUserId("user_state_cap")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Two breach ticks open the incident (consecutiveBreachesRequired: 2).
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			// Two more breach ticks: the counter saturates at 2, so the state row goes
			// quiet while the incident row keeps tracking the ongoing breach.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const stateRow = yield* Effect.promise(() =>
				queryFirstRow<{ consecutive_breaches: number; updated_at: Date | string }>(
					testDb,
					`select consecutive_breaches, updated_at from alert_rule_states
					 where rule_id = $1 and group_key = '__total__'`,
					[rule.id],
				),
			)
			assert.strictEqual(stateRow?.consecutive_breaches, 2)
			// Last state write was the tick that reached the cap (T+1m).
			assert.strictEqual(ms(stateRow?.updated_at), DEFAULT_CLOCK_EPOCH_MS + 60_000)

			const incidentRow = yield* Effect.promise(() =>
				queryFirstRow<{ status: string; last_evaluated_at: Date | string }>(
					testDb,
					`select status, last_evaluated_at from alert_incidents where rule_id = $1`,
					[rule.id],
				),
			)
			assert.strictEqual(incidentRow?.status, "open")
			assert.strictEqual(ms(incidentRow?.last_evaluated_at), DEFAULT_CLOCK_EPOCH_MS + 3 * 60_000)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("sends signed webhook test notifications", () => {
		const testDb = createTestDb(trackedDbs)
		const requests: Array<{ headers: Headers; body: string }> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				headers: new Headers(init?.headers),
				body: String(init?.body ?? ""),
			})
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_test_destination")
			const userId = asUserId("user_test_destination")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const response = yield* alerts.testDestination(orgId, userId, adminRoles, destination.id)

			assert.isTrue(response.success)
			assert.lengthOf(requests, 1)
			assert.strictEqual(requests[0]?.headers.get("x-maple-event-type"), "test")
			assert.isNotEmpty(requests[0]?.headers.get("x-maple-signature") ?? "")
			assert.include(requests[0]?.body ?? "", '"eventType":"test"')
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	it.effect("keeps processing queued deliveries when a rule evaluation fails", () => {
		const fixedTime = 1_710_000_000_000
		const testDb = createTestDb(trackedDbs)
		const requests: Array<{ headers: Headers }> = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ headers: new Headers(init?.headers) })
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			// Pin the clock to fixedTime so the pre-seeded delivery (scheduledAt: fixedTime - 1) is due.
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_eval_failure")
			const userId = asUserId("user_eval_failure")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					rule.id,
				]),
			)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000101",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: "manual-delivery-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 1,
					payloadJson: JSON.stringify({
						eventType: "test",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: "manual-dedupe-key",
						rule: {
							id: rule.id,
							name: rule.name,
							signalType: rule.signalType,
							severity: rule.severity,
							groupKey: null,
							comparator: rule.comparator,
							threshold: rule.threshold,
							windowMinutes: rule.windowMinutes,
						},
						observed: {
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			const tick = yield* alerts.runSchedulerTick()
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.strictEqual(tick.evaluationFailureCount, 1)
			assert.strictEqual(tick.processedCount, 1)
			assert.strictEqual(tick.deliveryFailureCount, 0)
			assert.lengthOf(requests, 1)
			assert.strictEqual(events.events[0]?.status, "success")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

	/**
	 * A `retry: "never"` failure is not retried for its own delivery, but before
	 * this nothing bounded the DESTINATION: a webhook whose provider answers 400
	 * forever kept receiving every new incident, failing, and losing the alert
	 * silently (observed in prod as a flat ~4/hr `AlertDeliveryRejectedError`).
	 */
	describe("destination auto-disable on repeated terminal failures", () => {
		const seedDeliveryFor = (
			testDb: TestDb,
			orgId: string,
			ruleId: string,
			destinationId: string,
			scheduledAt: number,
			n: number,
		) =>
			Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: `00000000-0000-4000-8000-00000000020${n}`,
					orgId,
					incidentId: null,
					ruleId,
					destinationId,
					deliveryKey: `dead-destination-${n}`,
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt,
					payloadJson: JSON.stringify({
						eventType: "test",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: `dead-destination-${n}`,
						observed: { value: 0, sampleCount: 0 },
					}),
				}),
			)

		/** Break the rule's stored query so the tick's evaluation half queues nothing of its own. */
		const breakRuleQuery = (testDb: TestDb, ruleId: string) =>
			Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					ruleId,
				]),
			)

		const readDestinationHealth = (testDb: TestDb, destinationId: string) =>
			Effect.promise(() =>
				queryFirstRow<{
					enabled: boolean
					consecutiveFailures: number
					disabledAt: Date | null
					disabledReason: string | null
				}>(
					testDb,
					`select enabled,
					        consecutive_failures as "consecutiveFailures",
					        disabled_at as "disabledAt",
					        disabled_reason as "disabledReason"
					 from alert_destinations where id = $1`,
					[destinationId],
				),
			)

		it.effect("disables the destination after three terminal failures and then skips it", () => {
			const fixedTime = 1_710_000_200_000
			const testDb = createTestDb(trackedDbs)
			let requestCount = 0
			// An empty-bodied 400 — the exact shape prod sees from Hazel.
			const rejectingFetch = (async () => {
				requestCount += 1
				return new Response("", { status: 400, headers: { "content-type": "application/json" } })
			}) as typeof fetch

			return Effect.gen(function* () {
				yield* TestClock.setTime(fixedTime)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_dest_disable")
				const userId = asUserId("user_dest_disable")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				yield* breakRuleQuery(testDb, rule.id)

				for (const n of [1, 2, 3]) {
					yield* seedDeliveryFor(testDb, orgId, rule.id, destination.id, fixedTime - 1, n)
				}
				yield* alerts.runSchedulerTick()

				assert.strictEqual(requestCount, 3)
				const health = yield* readDestinationHealth(testDb, destination.id)
				assert.strictEqual(health?.enabled, false)
				assert.strictEqual(health?.consecutiveFailures, 3)
				assert.isNotNull(health?.disabledAt ?? null)
				assert.include(health?.disabledReason ?? "", "delivery failed with 400")
				// The provider sent no body; the reason says so instead of trailing off.
				assert.include(health?.disabledReason ?? "", "<empty body>")

				// A delivery queued afterwards never reaches the provider again.
				yield* seedDeliveryFor(testDb, orgId, rule.id, destination.id, fixedTime - 1, 4)
				yield* alerts.runSchedulerTick()
				assert.strictEqual(requestCount, 3)

				const events = yield* alerts.listDeliveryEvents(orgId)
				const skipped = events.events.find(
					(event: { deliveryKey: string }) => event.deliveryKey === "dead-destination-4",
				)
				assert.strictEqual(skipped?.status, "failed")
				assert.strictEqual(skipped?.errorMessage, "Destination disabled")
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
						fetch: rejectingFetch,
					}),
				),
			)
		})

		it.effect("never disables a destination over Maple's own delivery faults", () => {
			const fixedTime = 1_710_000_250_000
			const testDb = createTestDb(trackedDbs)
			let requestCount = 0
			const countingFetch = (async () => {
				requestCount += 1
				return new Response("ok", { status: 200 })
			}) as typeof fetch

			return Effect.gen(function* () {
				yield* TestClock.setTime(fixedTime)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_dest_platform_fault")
				const userId = asUserId("user_dest_platform_fault")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				yield* breakRuleQuery(testDb, rule.id)
				// A secret that no longer decrypts, as after a bad key rotation.
				yield* Effect.promise(() =>
					executeSql(testDb, "update alert_destinations set secret_tag = $1 where id = $2", [
						Buffer.alloc(16, 7).toString("base64"),
						destination.id,
					]),
				)

				yield* Effect.forEach([1, 2, 3], (n) =>
					seedDeliveryFor(testDb, orgId, rule.id, destination.id, fixedTime - 1, n),
				)
				yield* alerts.runSchedulerTick()

				assert.strictEqual(requestCount, 0)
				const events = yield* alerts.listDeliveryEvents(orgId)
				assert.isTrue(events.events.every((event: { status: string }) => event.status === "failed"))
				const health = yield* readDestinationHealth(testDb, destination.id)
				assert.strictEqual(health?.enabled, true)
				assert.strictEqual(health?.consecutiveFailures, 0)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
						fetch: countingFetch,
					}),
				),
			)
		})

		it.effect("resets the streak on a successful delivery", () => {
			const fixedTime = 1_710_000_300_000
			const testDb = createTestDb(trackedDbs)
			let reject = true
			const flakyFetch = (async () =>
				reject
					? new Response("", { status: 400 })
					: new Response("ok", { status: 200 })) as typeof fetch

			return Effect.gen(function* () {
				yield* TestClock.setTime(fixedTime)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_dest_reset")
				const userId = asUserId("user_dest_reset")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				yield* breakRuleQuery(testDb, rule.id)

				// Two terminal failures — one short of the threshold.
				for (const n of [1, 2]) {
					yield* seedDeliveryFor(testDb, orgId, rule.id, destination.id, fixedTime - 1, n)
				}
				yield* alerts.runSchedulerTick()

				const afterFailures = yield* readDestinationHealth(testDb, destination.id)
				assert.strictEqual(afterFailures?.enabled, true)
				assert.strictEqual(afterFailures?.consecutiveFailures, 2)

				// One delivery gets through: the destination is alive, so the streak
				// is over and the next terminal failure starts counting from zero.
				reject = false
				yield* seedDeliveryFor(testDb, orgId, rule.id, destination.id, fixedTime - 1, 3)
				yield* alerts.runSchedulerTick()

				const afterSuccess = yield* readDestinationHealth(testDb, destination.id)
				assert.strictEqual(afterSuccess?.enabled, true)
				assert.strictEqual(afterSuccess?.consecutiveFailures, 0)
				assert.isNull(afterSuccess?.disabledAt ?? null)
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
						fetch: flakyFetch,
					}),
				),
			)
		})
	})

	it.effect("suppresses duplicate delivery sends across concurrent service instances", () => {
		const fixedTime = 1_710_000_100_000
		const testDb = createTestDb(trackedDbs)
		let requestCount = 0
		const fetchImpl = (async () => {
			requestCount += 1
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		const stub = makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows })
		const overrides = { fetch: fetchImpl }

		return Effect.gen(function* () {
			// One shared TestClock pinned to fixedTime backs every service instance below.
			yield* TestClock.setTime(fixedTime)
			const setup = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_dupe_guard")
				const userId = asUserId("user_dupe_guard")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				return { orgId, destination, rule }
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))

			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					setup.rule.id,
				]),
			)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000102",
					orgId: setup.orgId,
					incidentId: null,
					ruleId: setup.rule.id,
					destinationId: setup.destination.id,
					deliveryKey: "shared-delivery-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 1,
					payloadJson: JSON.stringify({
						eventType: "test",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: "shared-dedupe-key",
						rule: {
							id: setup.rule.id,
							name: setup.rule.name,
							signalType: setup.rule.signalType,
							severity: setup.rule.severity,
							groupKey: null,
							comparator: setup.rule.comparator,
							threshold: setup.rule.threshold,
							windowMinutes: setup.rule.windowMinutes,
						},
						observed: {
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			// Two independent service instances race to claim the same queued delivery;
			// the DB-level claim lease must let exactly one of them send it.
			const runTick = Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.runSchedulerTick()
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))

			const [tickA, tickB] = yield* Effect.all([runTick, runTick], {
				concurrency: "unbounded",
			})

			const events = yield* Effect.gen(function* () {
				const alerts = yield* AlertsService
				return yield* alerts.listDeliveryEvents(setup.orgId)
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))

			assert.strictEqual(requestCount, 1)
			assert.strictEqual(tickA.processedCount + tickB.processedCount, 1)
			assert.strictEqual(
				events.events.find((event) => event.deliveryKey === "shared-delivery-key")?.status,
				"success",
			)
		})
	})

	it.effect("skips duplicate delivery events and still creates the incident", () => {
		const fixedTime = 1_710_000_200_000
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
		const overrides = {
			...makeUuidSequence(
				"00000000-0000-4000-8000-000000000001",
				"00000000-0000-4000-8000-000000000002",
				"00000000-0000-4000-8000-000000000003",
				"00000000-0000-4000-8000-000000000004",
				"00000000-0000-4000-8000-000000000005",
			),
			fetch: okFetch,
		}
		const layer = makeLayer(testDb, makeWarehouseStub(state), overrides)

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_tx_rollback")
			const userId = asUserId("user_tx_rollback")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Immediate trigger",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 1,
					consecutiveHealthyRequired: 1,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)
			// Pre-insert a conflicting delivery event with the same delivery key
			// that processEvaluation will generate. With onConflictDoNothing(),
			// the duplicate insert is silently skipped and the incident is still created.
			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000099",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: `${"00000000-0000-4000-8000-000000000004"}:${destination.id}:trigger:${fixedTime}`,
					eventType: "trigger",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime + 60_000,
					payloadJson: JSON.stringify({
						eventType: "trigger",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: "conflict-dedupe",
						rule: {
							id: rule.id,
							name: rule.name,
							signalType: rule.signalType,
							severity: rule.severity,
							groupKey: null,
							comparator: rule.comparator,
							threshold: rule.threshold,
							windowMinutes: rule.windowMinutes,
						},
						observed: {
							value: 10,
							sampleCount: 200,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			const tick = yield* alerts.runSchedulerTick()
			const incidents = yield* alerts.listIncidents(orgId)
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.strictEqual(tick.evaluationFailureCount, 0)
			assert.lengthOf(incidents.incidents, 1)
			// Only the pre-existing event — the duplicate was silently skipped
			assert.lengthOf(events.events, 1)
			assert.include(events.events[0]?.deliveryKey ?? "", ":trigger:")
		}).pipe(Effect.provide(layer))
	})

	/**
	 * The delivery queue decides whether to re-enqueue from `error.error.retryable`,
	 * which comes from the failure class's policy. Every delivery failure used to
	 * be one `AlertDeliveryError` carrying `retry: "backoff"`, so a destination
	 * whose credentials had been revoked was retried the full
	 * `MAX_DELIVERY_ATTEMPTS` against a provider that would never accept it.
	 * These two cases are the guard on that split.
	 */
	const deliveryRetryCase = (
		label: string,
		status: number,
		expectRetry: boolean,
		expectedMessage: string,
	) =>
		it.effect(label, () => {
			const fixedTime = 1_710_000_400_000
			const testDb = createTestDb(trackedDbs)
			const respond = (async () => new Response("nope", { status })) as typeof fetch

			return Effect.gen(function* () {
				const alerts = yield* AlertsService
				const orgId = asOrgId(`org_retry_${status}`)
				const userId = asUserId(`user_retry_${status}`)
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				const deliveryKey = `retry-${status}-key`

				yield* Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-${String(status).padStart(12, "0")}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey,
						eventType: "test",
						attemptNumber: 1,
						status: "queued",
						scheduledAt: fixedTime - 1,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: `retry-${status}-dedupe`,
							rule: {
								id: rule.id,
								name: rule.name,
								signalType: rule.signalType,
								severity: rule.severity,
								groupKey: null,
								comparator: rule.comparator,
								threshold: rule.threshold,
								windowMinutes: rule.windowMinutes,
							},
							observed: { value: 0, sampleCount: 0 },
							linkUrl: "http://127.0.0.1:3471/alerts",
							sentAt: new Date(fixedTime).toISOString(),
						}),
					}),
				)

				const tick = yield* alerts.runSchedulerTick()
				const events = yield* alerts.listDeliveryEvents(orgId)

				assert.strictEqual(tick.deliveryFailureCount, 1)
				const firstAttempt = events.events.find(
					(event) => event.deliveryKey === deliveryKey && event.attemptNumber === 1,
				)
				const retryAttempt = events.events.find(
					(event) => event.deliveryKey === deliveryKey && event.attemptNumber === 2,
				)
				assert.strictEqual(firstAttempt?.status, "failed")
				assert.include(firstAttempt?.errorMessage ?? "", expectedMessage)
				if (expectRetry) {
					assert.strictEqual(retryAttempt?.status, "queued", "a transient failure must retry")
				} else {
					assert.isUndefined(retryAttempt, "a terminal failure must not enqueue another attempt")
				}
			}).pipe(
				Effect.provide(
					makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
						now: Effect.succeed(fixedTime),
						fetch: respond,
					}),
				),
			)
		})

	deliveryRetryCase(
		"does not retry a destination that rejected our credentials",
		401,
		false,
		"Webhook delivery failed with 401",
	)
	deliveryRetryCase(
		"retries a destination that is temporarily unavailable",
		503,
		true,
		"Webhook delivery failed with 503",
	)

	it.live("times out stuck deliveries and enqueues a retry attempt", () => {
		const fixedTime = 1_710_000_300_000
		const testDb = createTestDb(trackedDbs)
		const hangingFetch = (() => new Promise(() => {})) as typeof fetch

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_timeout")
			const userId = asUserId("user_timeout")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const lifecycleEvent = yield* Effect.fromResult(
				projectAlertLifecycleEvent({
					tenantId: orgId,
					ruleId: rule.id,
					ruleName: rule.name,
					incidentId: null,
					eventType: "test",
					incidentStatus: "resolved",
					groupKey: null,
					signalType: rule.signalType,
					severity: rule.severity,
					comparator: rule.comparator,
					threshold: rule.threshold,
					thresholdUpper: rule.thresholdUpper,
					windowMinutes: rule.windowMinutes,
					value: 0,
					sampleCount: 0,
					occurredAtMs: fixedTime,
				}),
			)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000103",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: "timeout-delivery-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 1,
					payloadJson: JSON.stringify({
						event: lifecycleEvent,
						eventType: "test",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: "timeout-dedupe-key",
						rule: {
							id: rule.id,
							name: rule.name,
							signalType: rule.signalType,
							severity: rule.severity,
							groupKey: null,
							comparator: rule.comparator,
							threshold: rule.threshold,
							windowMinutes: rule.windowMinutes,
						},
						observed: {
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
						futureAdditiveField: { preserve: true },
					}),
				}),
			)

			// The dispatch wraps the hanging fetch in a 10ms timeout driven by the
			// live runtime clock, so the timeout fires on its own in real time.
			const tick = yield* alerts.runSchedulerTick()
			const events = yield* alerts.listDeliveryEvents(orgId)
			const retryPayload = yield* Effect.promise(() =>
				queryFirstRow<{
					payload_json: {
						event?: unknown
						futureAdditiveField?: unknown
					}
				}>(
					testDb,
					"select payload_json from alert_delivery_events where delivery_key = $1 and attempt_number = 2",
					["timeout-delivery-key"],
				),
			)

			assert.strictEqual(tick.processedCount, 1)
			assert.strictEqual(tick.deliveryFailureCount, 1)
			const timeoutEvent = events.events.find(
				(event) => event.deliveryKey === "timeout-delivery-key" && event.attemptNumber === 1,
			)
			const retryEvent = events.events.find(
				(event) => event.deliveryKey === "timeout-delivery-key" && event.attemptNumber === 2,
			)
			assert.strictEqual(timeoutEvent?.status, "failed")
			assert.include(timeoutEvent?.errorMessage ?? "", "timed out")
			assert.strictEqual(retryEvent?.status, "queued")
			assert.deepStrictEqual(retryPayload?.payload_json.event, lifecycleEvent)
			assert.deepStrictEqual(retryPayload?.payload_json.futureAdditiveField, { preserve: true })
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					now: Effect.succeed(fixedTime),
					fetch: hangingFetch,
					deliveryTimeoutMs: () => 10,
				}),
			),
		)
	})

	it.effect("marks corrupted queued payloads as failed without blocking later deliveries", () => {
		const fixedTime = 1_710_000_400_000
		const testDb = createTestDb(trackedDbs)
		let requestCount = 0
		const fetchImpl = (async () => {
			requestCount += 1
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_payload_isolation")
			const userId = asUserId("user_payload_isolation")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000104",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: "bad-payload-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 2,
					// jsonb can only hold valid JSON, so "corrupted" now means a stored
					// payload that fails the delivery-payload schema decode (every field
					// is optional, so it must be present-but-mistyped).
					payloadJson: JSON.stringify({ eventType: 123 }),
				}),
			)
			yield* Effect.promise(() =>
				insertDeliveryEventRow(testDb, {
					id: "00000000-0000-4000-8000-000000000105",
					orgId,
					incidentId: null,
					ruleId: rule.id,
					destinationId: destination.id,
					deliveryKey: "good-payload-key",
					eventType: "test",
					attemptNumber: 1,
					status: "queued",
					scheduledAt: fixedTime - 1,
					payloadJson: JSON.stringify({
						eventType: "test",
						incidentId: null,
						incidentStatus: "resolved",
						dedupeKey: "good-payload-dedupe",
						rule: {
							id: rule.id,
							name: rule.name,
							signalType: rule.signalType,
							severity: rule.severity,
							groupKey: null,
							comparator: rule.comparator,
							threshold: rule.threshold,
							windowMinutes: rule.windowMinutes,
						},
						observed: {
							value: 0,
							sampleCount: 0,
						},
						linkUrl: "http://127.0.0.1:3471/alerts",
						sentAt: new Date(fixedTime).toISOString(),
					}),
				}),
			)

			const tick = yield* alerts.runSchedulerTick()
			const events = yield* alerts.listDeliveryEvents(orgId)

			assert.strictEqual(tick.processedCount, 2)
			assert.strictEqual(tick.deliveryFailureCount, 1)
			assert.strictEqual(requestCount, 1)
			assert.strictEqual(
				events.events.find((event) => event.deliveryKey === "bad-payload-key")?.status,
				"failed",
			)
			assert.strictEqual(
				events.events.find((event) => event.deliveryKey === "good-payload-key")?.status,
				"success",
			)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})

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

describe("AlertsService evaluation error persistence", () => {
	const failingWarehouseStub = (state: {
		failing: boolean
		rows: ReadonlyArray<Record<string, unknown>>
		ingested: Array<Record<string, unknown>>
		failure?: WarehouseQueryError | WarehouseUpstreamError
	}): WarehouseQueryServiceApi => {
		const sqlQueryStub = () =>
			state.failing
				? Effect.fail(
						state.failure ??
							new WarehouseQueryError({
								message: "Unknown column FooBar in traces",
								pipeName: "tracesAlertEval",
							}),
					)
				: Effect.succeed(state.rows)
		return {
			query: () => Effect.die(new Error("Unexpected pipe query")),
			sqlQuery: sqlQueryStub,
			rawSqlQuery: sqlQueryStub,
			compiledQuery: (_tenant, compiled) =>
				sqlQueryStub().pipe(
					Effect.flatMap((rows) => compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)),
				),
			compiledQueryWithCapabilities: (_tenant, compile) =>
				sqlQueryStub().pipe(
					Effect.flatMap((rows) =>
						Effect.runSync(compile(baselineWarehouseCapabilities()))
							.decodeRows(rows)
							.pipe(Effect.orDie),
					),
				),
			compiledQueryFirst: (_tenant, compiled) =>
				sqlQueryStub().pipe(
					Effect.flatMap((rows) =>
						compiledQueryOf(compiled).decodeFirstRow(rows).pipe(Effect.orDie),
					),
				),
			ingest: (_tenant, _datasource, rows) =>
				Effect.sync(() => {
					state.ingested.push(...(rows as Array<Record<string, unknown>>))
				}),
			asExecutor: () => {
				throw new Error("asExecutor is not supported by this test stub")
			},
		}
	}

	it.effect("retries a failed long-window rule on the next tick, then settles onto its interval", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [] as ReadonlyArray<Record<string, unknown>>,
			ingested: [] as Array<Record<string, unknown>>,
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_retry")
			const userId = asUserId("user_alert_retry")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Retry rule",
					severity: "warning",
					enabled: true,
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 30,
					destinationIds: [destination.id],
				}),
			)
			const tickAndCount = Effect.gen(function* () {
				yield* alerts.runSchedulerTick()
				yield* TestClock.adjust(Duration.minutes(1))
				return state.ingested.length
			})

			// Two failing ticks then a clean one, each a minute apart.
			const failing = yield* Effect.forEach(Arr.range(1, 2), () => tickAndCount)
			state.failing = false
			const recovered = yield* tickAndCount
			assert.deepStrictEqual([...failing, recovered], [1, 2, 3])
			// Healthy again, it waits for its 5-minute slot.
			const later = yield* Effect.forEach(Arr.range(1, 4), () => tickAndCount)
			assert.isBelow(later[3]! - recovered, 4)
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("persists scheduler failures to lastError + audit log, gated, and clears on recovery", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [
				tracesRow({
					count: 200,
					avgDuration: 40,
					p50Duration: 20,
					p95Duration: 120,
					p99Duration: 240,
					errorRate: 1,
					satisfiedCount: 180,
					toleratingCount: 10,
					apdexScore: 0.925,
				}),
			],
			ingested: [] as Array<Record<string, unknown>>,
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_errors")
			const userId = asUserId("user_alert_errors")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			// Failing tick: the error must land in alert_rule_states.lastError, be
			// surfaced on listRules, and produce an "error" audit check row.
			yield* alerts.runSchedulerTick()

			const rulesWhileFailing = yield* alerts.listRules(orgId)
			assert.strictEqual(
				rulesWhileFailing.rules[0]?.lastEvaluationError,
				"Unknown column FooBar in traces",
			)
			const errorChecks = state.ingested.filter((row) => row.Status === "error")
			assert.lengthOf(errorChecks, 1)
			assert.strictEqual(errorChecks[0]?.ErrorMessage, "Unknown column FooBar in traces")
			assert.strictEqual(errorChecks[0]?.ErrorCategory, "warehouse_query_failed")
			assert.strictEqual(errorChecks[0]?.GroupKey, "__total__")
			assert.strictEqual(errorChecks[0]?.SkipReason, "")

			const stateAfterFirstFailure = yield* Effect.promise(() =>
				queryFirstRow<{ updated_at: Date }>(
					testDb,
					"select updated_at from alert_rule_states where rule_id = $1 and group_key = '__total__'",
					[rule.id],
				),
			)
			assert.isDefined(stateAfterFirstFailure)

			// Second failing tick with the SAME message inside the heartbeat window:
			// churn-gated, so the Electric-synced state row must NOT be rewritten.
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const stateAfterSecondFailure = yield* Effect.promise(() =>
				queryFirstRow<{ updated_at: Date }>(
					testDb,
					"select updated_at from alert_rule_states where rule_id = $1 and group_key = '__total__'",
					[rule.id],
				),
			)
			assert.strictEqual(
				stateAfterSecondFailure?.updated_at.getTime(),
				stateAfterFirstFailure?.updated_at.getTime(),
			)

			// Recovery: a clean evaluation clears the stored error.
			state.failing = false
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const rulesAfterRecovery = yield* alerts.listRules(orgId)
			assert.isNull(rulesAfterRecovery.rules[0]?.lastEvaluationError)
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("skips rules on a warehouse outage without counting failures, warning once per org", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [],
			ingested: [] as Array<Record<string, unknown>>,
			failure: new WarehouseUpstreamError({
				message: "HTTP 503",
				pipeName: "tracesAlertEval",
				upstreamStatus: 503,
			}),
		}
		const logs: Array<{ readonly message: string; readonly level: string }> = []
		const captureLogs = Logger.layer([
			Logger.make(({ message, logLevel }) => {
				logs.push({ message: String(message), level: logLevel })
			}),
		])

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_outage")
			const userId = asUserId("user_alert_outage")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id, "Outage rule A")
			yield* createErrorRateRule(alerts, orgId, userId, destination.id, "Outage rule B")

			const tick = yield* alerts.runSchedulerTick()

			assert.strictEqual(tick.evaluationFailureCount, 0)
			assert.strictEqual(tick.warehouseUnavailableSkipCount, 2)
			assert.lengthOf(
				logs.filter((log) => log.message.includes("Alert rule evaluation failed")),
				0,
			)
			const outageWarnings = logs.filter((log) =>
				log.message.includes("Alert rule evaluations skipped: warehouse unavailable"),
			)
			assert.lengthOf(outageWarnings, 1)
			assert.strictEqual(outageWarnings[0]?.level, "Warn")
			// The check history still shows the gap, labelled as an outage.
			const checks = state.ingested.filter((row) => row.Status === "error")
			assert.lengthOf(checks, 2)
			assert.isTrue(checks.every((row) => row.ErrorCategory === "warehouse_unavailable"))
			const rules = yield* alerts.listRules(orgId)
			// Not the rule's fault, so the rule is not flagged as failing.
			assert.isTrue(rules.rules.every((rule) => rule.lastEvaluationError === null))
		}).pipe(
			Effect.provide(
				Layer.merge(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch }), captureLogs),
			),
		)
	})

	it.effect("skips the rest of an org's rules once its warehouse is down this tick", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [],
			ingested: [] as Array<Record<string, unknown>>,
			failure: new WarehouseUpstreamError({
				message: "HTTP 503",
				pipeName: "tracesAlertEval",
				upstreamStatus: 503,
			}),
		}
		const base = failingWarehouseStub(state)
		let warehouseQueries = 0
		const counted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.suspend(() => {
				warehouseQueries += 1
				return effect
			})
		const stub: WarehouseQueryServiceApi = {
			...base,
			sqlQuery: (...args) => counted(base.sqlQuery(...args)),
			rawSqlQuery: (...args) => counted(base.rawSqlQuery(...args)),
			compiledQuery: (...args) => counted(base.compiledQuery(...args)),
			compiledQueryWithCapabilities: (...args) => counted(base.compiledQueryWithCapabilities(...args)),
			compiledQueryFirst: (...args) => counted(base.compiledQueryFirst(...args)),
		}
		const ruleCount = 8

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_outage_breaker")
			const userId = asUserId("user_alert_outage_breaker")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			for (const n of Array.from({ length: ruleCount }, (_, i) => i)) {
				yield* createErrorRateRule(alerts, orgId, userId, destination.id, `Outage rule ${n}`)
			}

			const tick = yield* alerts.runSchedulerTick()

			// Every rule is accounted for as an outage skip, none as the rule's fault.
			assert.strictEqual(tick.warehouseUnavailableSkipCount, ruleCount)
			assert.strictEqual(tick.evaluationFailureCount, 0)
			// Only the rules already in flight when the first failure landed queried
			// the warehouse; the rest were skipped without waiting on it.
			assert.isBelow(warehouseQueries, ruleCount)
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	})

	it.effect("still counts a 4xx upstream rejection as an evaluation failure", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			rows: [],
			ingested: [] as Array<Record<string, unknown>>,
			failure: new WarehouseUpstreamError({
				message: "HTTP 429",
				pipeName: "tracesAlertEval",
				upstreamStatus: 429,
			}),
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_rejected")
			const userId = asUserId("user_alert_rejected")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			const tick = yield* alerts.runSchedulerTick()

			assert.strictEqual(tick.evaluationFailureCount, 1)
			assert.strictEqual(tick.warehouseUnavailableSkipCount, 0)
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("opens an incident on empty windows when the rule alerts on no data", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { failing: false, rows: [], ingested: [] as Array<Record<string, unknown>> }

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_on_no_data")
			const userId = asUserId("user_alert_on_no_data")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Checkout goes blind",
					severity: "critical",
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 1,
					alertOnNoData: true,
					destinationIds: [destination.id],
				}),
			)
			assert.strictEqual(rule.noDataBehavior, "alert")

			yield* alerts.runSchedulerTick()

			const breached = state.ingested.filter((row) => row.Status === "breached")
			assert.lengthOf(breached, 1)
			assert.isNull(breached[0]?.ObservedValue)
			assert.strictEqual(breached[0]?.IncidentTransition, "opened")
			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			assert.strictEqual(incidents.incidents[0]?.status, "open")
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("keeps alertOnNoData on a low-throughput rule and rejects it on a grouped one", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { failing: false, rows: [], ingested: [] as Array<Record<string, unknown>> }

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_on_no_data_shapes")
			const userId = asUserId("user_alert_on_no_data_shapes")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const request = (fields: Partial<ConstructorParameters<typeof AlertRuleUpsertRequest>[0]>) =>
				new AlertRuleUpsertRequest({
					name: "No data shapes",
					severity: "critical",
					signalType: "throughput",
					comparator: "lt",
					threshold: 10,
					windowMinutes: 5,
					minimumSampleCount: 50,
					consecutiveBreachesRequired: 1,
					alertOnNoData: true,
					destinationIds: [destination.id],
					...fields,
				})

			// Read as zero, an empty window would be skipped under the minimum; alert wins.
			const throughput = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				request({ serviceNames: ["checkout"] }),
			)
			assert.strictEqual(throughput.noDataBehavior, "alert")
			yield* alerts.runSchedulerTick()
			assert.lengthOf(
				state.ingested.filter((row) => row.Status === "breached" && row.ObservedValue === null),
				1,
			)

			const grouped = yield* alerts
				.createRule(
					orgId,
					userId,
					adminRoles,
					request({ name: "Grouped", groupBy: ["service.name"] }),
				)
				.pipe(Effect.flip)
			assert.instanceOf(grouped, AlertValidationError)
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("records why a check skipped when the window has no data", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { failing: false, rows: [], ingested: [] as Array<Record<string, unknown>> }

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_alert_skip_reason")
			const userId = asUserId("user_alert_skip_reason")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()

			const skipped = state.ingested.filter((row) => row.Status === "skipped")
			assert.lengthOf(skipped, 1)
			assert.strictEqual(skipped[0]?.SkipReason, "no_data")
		}).pipe(Effect.provide(makeLayer(testDb, failingWarehouseStub(state), { fetch: okFetch })))
	})
})

describe("AlertsService.previewRule", () => {
	const decodePreviewRequest = Schema.decodeUnknownSync(AlertRulePreviewRequest)

	const bucketRow = (bucket: string, errorRate: number) =>
		tracesRow({
			bucket,
			count: 200,
			avgDuration: 40,
			p50Duration: 20,
			p95Duration: 120,
			p99Duration: 240,
			errorRate,
			satisfiedCount: 180,
			toleratingCount: 10,
			apdexScore: 0.925,
		})

	it.effect("returns evaluator-bucketed points and would-fire spans for a spec rule", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				bucketRow("2026-01-01 00:00:00", 10),
				bucketRow("2026-01-01 00:05:00", 12),
				bucketRow("2026-01-01 00:10:00", 1),
			],
		}

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview")

			// No destinations picked yet — preview must not require them.
			const request = decodePreviewRequest({
				rule: {
					name: "Preview rule",
					severity: "critical",
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
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

			const response = yield* alerts.previewRule(orgId, adminRoles, request)

			assert.strictEqual(response.bucketSeconds, 300)
			assert.strictEqual(response.windowMinutes, 5)
			assert.lengthOf(response.series, 1)
			const points = response.series[0]!.points
			// 30-minute range at 5-minute windows = 6 evaluation buckets, with the
			// three data-less windows filled in as skipped.
			assert.lengthOf(points, 6)
			assert.strictEqual(points[0]?.status, "breached")
			assert.strictEqual(points[1]?.status, "breached")
			assert.strictEqual(points[2]?.status, "healthy")
			assert.strictEqual(points[3]?.status, "skipped")
			assert.strictEqual(points[0]?.value, 10)
			assert.strictEqual(points[0]?.sampleCount, 200)

			// 2 consecutive breaches required → fires across the first two windows,
			// resolved after 2 consecutive healthy... only 1 healthy then skipped
			// (which freezes counters), so no close within the window either way.
			assert.lengthOf(response.wouldFire, 1)
			assert.strictEqual(response.wouldFire[0]?.start, "2026-01-01T00:00:00.000Z")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("covers the whole requested range for the create form's default shape", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: [bucketRow("2026-01-01 00:00:00", 10)] }

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview_full_range")

			const request = decodePreviewRequest({
				rule: {
					name: "Preview rule",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					// The create form's defaults: a 5-minute window over the last 24h.
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-02T00:00:00.000Z",
			})

			const response = yield* alerts.previewRule(orgId, adminRoles, request)

			// 288 windows — the bucket cap used to stop at 200, so the chart drew
			// only the newest 16h40m of a full-width 24h axis.
			const points = response.series[0]!.points
			assert.lengthOf(points, 288)
			assert.isNull(response.truncatedToStart)
			assert.strictEqual(points[0]?.bucket, "2026-01-01T00:00:00.000Z")
			assert.strictEqual(points[287]?.bucket, "2026-01-01T23:55:00.000Z")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("clamps to the newest windows and reports the clamp when the range is too long", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { tracesAggregateRows: [bucketRow("2026-01-01 00:00:00", 10)] }

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview_clamped")

			const request = decodePreviewRequest({
				rule: {
					name: "Preview rule",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					// 1-minute windows over 30 days is 43,200 evaluations — far past
					// anything a preview replays.
					windowMinutes: 1,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-31T00:00:00.000Z",
			})

			const response = yield* alerts.previewRule(orgId, adminRoles, request)

			const points = response.series[0]!.points
			assert.lengthOf(points, 1500)
			// The clamped start is what the chart frames its axis on.
			assert.strictEqual(response.truncatedToStart, "2026-01-29T23:00:00.000Z")
			assert.strictEqual(points[0]?.bucket, "2026-01-29T23:00:00.000Z")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("adds a provisional point for the trailing partial window", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			tracesAggregateRows: [
				bucketRow("2026-01-01 00:00:00", 10),
				bucketRow("2026-01-01 00:05:00", 12),
				bucketRow("2026-01-01 00:30:00", 8),
			],
		}

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview_partial")

			const request = decodePreviewRequest({
				rule: {
					name: "Preview rule",
					severity: "critical",
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
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				// 2.5 minutes past the last complete 5-minute boundary.
				endTime: "2026-01-01T00:32:30.000Z",
			})

			const response = yield* alerts.previewRule(orgId, adminRoles, request)

			assert.lengthOf(response.series, 1)
			const points = response.series[0]!.points
			// 6 complete windows plus the in-progress [00:30, 00:32:30) one.
			assert.lengthOf(points, 7)
			assert.isUndefined(points[5]?.provisional)
			const last = points[6]!
			assert.strictEqual(last.bucket, "2026-01-01T00:30:00.000Z")
			assert.strictEqual(last.provisional, true)
			assert.strictEqual(last.status, "breached")
			assert.strictEqual(last.value, 8)

			// The provisional window charts but must not extend the would-fire
			// simulation: the span from the two opening breaches stays the only one,
			// closed at the last complete boundary.
			assert.lengthOf(response.wouldFire, 1)
			assert.strictEqual(response.wouldFire[0]?.start, "2026-01-01T00:00:00.000Z")
			assert.strictEqual(response.wouldFire[0]?.end, "2026-01-01T00:30:00.000Z")
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("previews a raw-SQL rule through the same path as every other kind", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { rawQueryRows: [{ value: 42, samples: 20 }] }

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_preview_raw")

			const request = decodePreviewRequest({
				rule: {
					name: "Raw preview",
					severity: "warning",
					enabled: true,
					signalType: "raw_query",
					rawQuerySql:
						"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					rawQueryReducer: "max",
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					minimumSampleCount: 0,
					consecutiveBreachesRequired: 2,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

			// Raw SQL used to be rejected here even though the UI offers the chart.
			// It is now just another evaluate source, so the preview renders.
			const preview = yield* alerts.previewRule(orgId, adminRoles, request)
			assert.isAbove(preview.series.length, 0)
			const points = preview.series[0]?.points ?? []
			assert.isAbove(points.length, 0)
			assert.isTrue(points.some((p) => p.value === 42))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("charts a no-data series for a raw-SQL rule whose query matches nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const state = { rawQueryRows: [] }

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const request = decodePreviewRequest({
				rule: {
					name: "Raw preview empty",
					severity: "warning",
					signalType: "raw_query",
					rawQuerySql:
						"SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)",
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

			// The scheduler sees one no-data observation per tick here, so the preview must too.
			const preview = yield* alerts.previewRule(asOrgId("org_preview_raw_empty"), adminRoles, request)
			assert.lengthOf(preview.series, 1)
			const points = preview.series[0]?.points ?? []
			assert.lengthOf(points, 6)
			assert.isTrue(points.every((p) => p.status === "skipped" && p.skipReason === "no_data"))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("previews a grouped raw-SQL rule that alerts on no data the way the scheduler fires", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rawQueryRows: [
				{ bucket: "2026-01-01 00:00:00", group: "a", value: 1, samples: 5 },
				{ bucket: "2026-01-01 00:05:00", group: "a", value: 1, samples: 5 },
			],
		}

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const request = decodePreviewRequest({
				rule: {
					name: "Raw grouped no data",
					severity: "warning",
					signalType: "raw_query",
					rawQuerySql:
						"SELECT $__timeGroup(Timestamp) AS bucket, ServiceName AS group, count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY bucket, group",
					comparator: "gt",
					threshold: 10,
					windowMinutes: 5,
					consecutiveBreachesRequired: 1,
					alertOnNoData: true,
					destinationIds: [],
				},
				startTime: "2026-01-01T00:00:00.000Z",
				endTime: "2026-01-01T00:30:00.000Z",
			})

			const preview = yield* alerts.previewRule(asOrgId("org_preview_raw_grouped"), adminRoles, request)
			const byGroup = new Map(preview.series.map((series) => [series.groupKey, series.points]))
			// A group missing from a tick is not evaluated by the scheduler, so it never breaches.
			const a = byGroup.get("a") ?? []
			assert.isTrue(a.slice(2).every((p) => p.status === "skipped" && p.skipReason === "no_data"))
			// Ticks where nothing reported at all breach under the empty-result key.
			const empty = byGroup.get("all") ?? []
			assert.deepStrictEqual(
				empty.map((p) => p.status),
				["healthy", "healthy", "breached", "breached", "breached", "breached"],
			)
			assert.isTrue(preview.wouldFire.every((span) => span.groupKey === "all"))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: okFetch })))
	})

	it.effect("dedupes rule destinations and environments, preserving order", () => {
		const testDb = createTestDb(trackedDbs)
		// Guards the `Arr.dedupe` calls in normalizeRule. A destination listed twice
		// still notifies once, and the surviving order is first-occurrence — the
		// same contract `[...new Set()]` gave before.
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_dedupe")
			const userId = asUserId("user_dedupe")
			const first = yield* createWebhookDestination(alerts, orgId, userId)
			const second = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "webhook",
				name: "Secondary webhook",
				enabled: true,
				url: "https://example.com/maple-alerts-2",
				signingSecret: "webhook-secret-2",
			})

			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Deduped rule",
					severity: "warning",
					enabled: true,
					serviceNames: ["checkout"],
					environments: ["  prod  ", "staging", "prod", "   ", "staging"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					destinationIds: [second.id, first.id, second.id],
				}),
			)

			assert.deepStrictEqual(rule.destinationIds, [second.id, first.id])
			// Trimmed, blank-dropped, deduped, first-occurrence order.
			assert.deepStrictEqual(rule.environments, ["prod", "staging"])
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	it.effect("keeps scheduler tick round-trips flat as rule count grows", () => {
		const testDb = createTestDb(trackedDbs)
		const counter = { executes: 0 }
		// Counts `Database.execute` calls, which is the unit that costs: under
		// `DatabasePgLive` each one dials and tears down its own postgres.js client.
		// This guards the tick-head prefetch and the set-based housekeeping against
		// someone re-adding a statement inside the per-rule loop — which is exactly
		// how the tick reached ~7 dials per rule per minute in production.
		const countingDb = {
			...testDb,
			layer: Layer.effect(
				Database,
				Effect.gen(function* () {
					const inner = yield* Database
					return Database.of({
						execute: (fn) => {
							counter.executes += 1
							return inner.execute(fn)
						},
					})
				}),
			).pipe(Layer.provide(testDb.layer)),
		}

		const seedRules = (
			alerts: AlertsServiceApi,
			orgId: ReturnType<typeof asOrgId>,
			userId: ReturnType<typeof asUserId>,
			destinationId: AlertDestinationId,
			from: number,
			count: number,
		) =>
			Effect.forEach(
				Array.from({ length: count }, (_, index) => from + index),
				(index) =>
					alerts.createRule(
						orgId,
						userId,
						adminRoles,
						new AlertRuleUpsertRequest({
							name: `Scaling rule ${index}`,
							severity: "warning",
							enabled: true,
							serviceNames: ["checkout"],
							signalType: "error_rate",
							comparator: "gt",
							threshold: 5,
							windowMinutes: 5,
							destinationIds: [destinationId],
						}),
					),
				{ concurrency: 1, discard: true },
			)

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_roundtrip")
			const userId = asUserId("user_roundtrip")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* seedRules(alerts, orgId, userId, destination.id, 0, 3)
			counter.executes = 0
			yield* alerts.runSchedulerTick()
			const forThree = counter.executes

			yield* seedRules(alerts, orgId, userId, destination.id, 3, 9)
			yield* TestClock.adjust(Duration.minutes(1))
			counter.executes = 0
			yield* alerts.runSchedulerTick()
			const forTwelve = counter.executes

			// Four times the rules must not cost four times the round-trips. The old
			// shape was ~7 per rule, so 3 → 12 rules would have added ~63 executes.
			const perExtraRule = (forTwelve - forThree) / 9
			assert.isBelow(
				perExtraRule,
				3,
				`expected well under 3 executes per additional rule, got ${perExtraRule} (${forThree} for 3 rules, ${forTwelve} for 12)`,
			)
		}).pipe(Effect.provide(makeLayer(countingDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	it.effect("does not auto-resolve an incident whose group is still evaluating", () => {
		const testDb = createTestDb(trackedDbs)
		// A grouped rule where both groups stay breached across two ticks. The tick
		// reads open incidents from a tick-head prefetch now, so this is the
		// regression guard for that snapshot going stale: neither group is orphaned,
		// so `resolveOrphanedGroupIncidents` must leave both incidents open rather
		// than firing an all-clear for the one it saw before this tick's writes.
		// Rows in the shape the `error_rate` timeseries actually returns. They used
		// to be `{ groupKey, value, sampleCount }` — a shape from an older
		// evaluation path that nothing decoded, so nothing noticed.
		const breachedGroups = {
			tracesAggregateRows: [
				tracesRow({ groupName: "checkout", count: 500, errorRate: 42 }),
				tracesRow({ groupName: "payments", count: 500, errorRate: 37 }),
			],
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_orphan_guard")
			const userId = asUserId("user_orphan_guard")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Grouped error rate",
					severity: "critical",
					enabled: true,
					serviceNames: ["checkout", "payments"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 1,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)

			yield* alerts.runSchedulerTick()
			const afterFirst = yield* alerts.listIncidents(orgId)
			const openAfterFirst = afterFirst.incidents.filter((i) => i.status === "open")

			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			const afterSecond = yield* alerts.listIncidents(orgId)
			const openAfterSecond = afterSecond.incidents.filter((i) => i.status === "open")
			const resolvedAfterSecond = afterSecond.incidents.filter((i) => i.status === "resolved")

			// Still breaching on the second tick, so nothing may have been resolved.
			assert.strictEqual(
				openAfterSecond.length,
				openAfterFirst.length,
				"a still-breaching group lost its open incident",
			)
			assert.lengthOf(resolvedAfterSecond, 0)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(breachedGroups), { fetch: okFetch })))
	})
})

describe("AlertsService delivery lease freshness", () => {
	it.effect("claims later rows with a fresh timestamp, not the batch head's", () => {
		const fixedTime = 1_710_000_400_000
		const testDb = createTestDb(trackedDbs)
		// Virtual scheduler clock: the first delivery "takes" most of the drain
		// budget, so a second claim dated from the batch-head timestamp would
		// expire mid-delivery and an overlapping tick could re-send the event.
		let virtualNow = fixedTime
		let call = 0
		let laterRowLeaseExpiry: number | null = null
		const fetchImpl = (async () => {
			call += 1
			if (call === 1) {
				virtualNow += 19_000
			} else {
				const row = await queryFirstRow<{ claimExpiresAt: Date | null }>(
					testDb,
					`select claim_expires_at as "claimExpiresAt"
					 from alert_delivery_events where delivery_key = 'lease-2'`,
					[],
				)
				laterRowLeaseExpiry = row?.claimExpiresAt?.getTime() ?? null
			}
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_lease_fresh")
			const userId = asUserId("user_lease_fresh")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			// Break the rule's stored query so the tick's evaluation half queues
			// nothing of its own.
			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					rule.id,
				]),
			)

			for (const n of [1, 2]) {
				yield* Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-00000000030${n}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey: `lease-${n}`,
						eventType: "test",
						attemptNumber: 1,
						status: "queued",
						// Row 1 first: rows are processed in scheduledAt order.
						scheduledAt: fixedTime - 10 + n,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: `lease-${n}`,
							observed: { value: 0, sampleCount: 0 },
						}),
					}),
				)
			}
			yield* alerts.runSchedulerTick()

			assert.strictEqual(call, 2)
			// The second claim must be dated from its own claim time (after the
			// 19s "slow" first delivery). A batch-head lease would end at
			// fixedTime + TTL, 19s short of the one this delivery holds.
			assert.isNotNull(laterRowLeaseExpiry)
			assert.isAbove(laterRowLeaseExpiry ?? 0, fixedTime + 30_000)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
					now: Effect.sync(() => virtualNow),
				}),
			),
		)
	})
})

describe("AlertsService delivery drain across destinations", () => {
	it.effect("a slow destination costs its own rows, not another destination's page", () => {
		const fixedTime = 1_710_000_450_000
		const testDb = createTestDb(trackedDbs)
		// Virtual clock: every delivery to the slow endpoint "takes" 15s.
		let virtualNow = fixedTime
		const delivered: Array<string> = []
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url === "https://example.com/maple-alerts") virtualNow += 15_000
			delivered.push(url)
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_drain_fairness")
			const userId = asUserId("user_drain_fairness")
			const slow = yield* createWebhookDestination(alerts, orgId, userId)
			const fast = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "webhook",
				name: "Fast webhook",
				enabled: true,
				url: "https://example.com/fast",
				signingSecret: "webhook-secret",
			})
			const rule = yield* createErrorRateRule(alerts, orgId, userId, slow.id)
			// Break the rule's stored query so the tick queues nothing of its own.
			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_rules set query_spec_json = $1::jsonb where id = $2", [
					"{}",
					rule.id,
				]),
			)

			// Three rows for the slow endpoint, queued ahead of the fast one's.
			const queued = [
				[slow.id, "slow-1"],
				[slow.id, "slow-2"],
				[slow.id, "slow-3"],
				[fast.id, "fast-1"],
			] as const
			for (const [index, [destinationId, deliveryKey]] of queued.entries()) {
				yield* Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-00000000040${index}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId,
						deliveryKey,
						eventType: "test",
						attemptNumber: 1,
						status: "queued",
						scheduledAt: fixedTime - 10 + index,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: deliveryKey,
							observed: { value: 0, sampleCount: 0 },
						}),
					}),
				)
			}
			yield* alerts.runSchedulerTick()

			const statuses = yield* Effect.promise(() =>
				testDb.pglite.query<{ deliveryKey: string; status: string }>(
					`select delivery_key as "deliveryKey", status from alert_delivery_events order by delivery_key`,
				),
			)
			assert.include(delivered, "https://example.com/fast")
			assert.deepStrictEqual(
				statuses.rows.map((row) => [row.deliveryKey, row.status]),
				[
					["fast-1", "success"],
					["slow-1", "success"],
					["slow-2", "success"],
					// Started past the drain budget, so it waits for the next tick.
					["slow-3", "queued"],
				],
			)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
					now: Effect.sync(() => virtualNow),
				}),
			),
		)
	})
})

describe("AlertsService tick isolation", () => {
	const breachedRows = () =>
		[
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
		] as ReadonlyArray<Record<string, unknown>>

	it.effect("a rule that crashes does not stop the other rules in the tick", () => {
		const testDb = createTestDb(trackedDbs)
		const crashingOrg = asOrgId("org_crash_rule")
		const base = makeWarehouseStub({ tracesAggregateRows: breachedRows() })
		const crashFor =
			(orgId: string) =>
			<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
				orgId === crashingOrg ? Effect.die(new Error("warehouse client bug")) : effect
		const stub: WarehouseQueryServiceApi = {
			...base,
			sqlQuery: (tenant, ...rest) => crashFor(tenant.orgId)(base.sqlQuery(tenant, ...rest)),
			rawSqlQuery: (tenant, ...rest) => crashFor(tenant.orgId)(base.rawSqlQuery(tenant, ...rest)),
			compiledQuery: (tenant, ...rest) => crashFor(tenant.orgId)(base.compiledQuery(tenant, ...rest)),
			compiledQueryWithCapabilities: (tenant, ...rest) =>
				crashFor(tenant.orgId)(base.compiledQueryWithCapabilities(tenant, ...rest)),
			compiledQueryFirst: (tenant, ...rest) =>
				crashFor(tenant.orgId)(base.compiledQueryFirst(tenant, ...rest)),
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const healthyOrg = asOrgId("org_crash_neighbour")
			const userId = asUserId("user_crash")
			// Created first, so the crashing rule is evaluated first.
			const crashing = yield* createErrorRateRule(
				alerts,
				crashingOrg,
				userId,
				(yield* createWebhookDestination(alerts, crashingOrg, userId)).id,
			)
			yield* createErrorRateRule(
				alerts,
				healthyOrg,
				userId,
				(yield* createWebhookDestination(alerts, healthyOrg, userId)).id,
			)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(healthyOrg)
			assert.strictEqual(incidents.incidents[0]?.status, "open")
			const crashed = (yield* alerts.listRules(crashingOrg)).rules.find((r) => r.id === crashing.id)
			assert.include(crashed?.lastEvaluationError ?? "", "Internal error")
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	})

	it.effect("a delivery row that crashes is failed once and does not block the queue", () => {
		const fixedTime = 1_710_000_500_000
		const testDb = createTestDb(trackedDbs)
		const sent: string[] = []
		const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			sent.push(String(init?.body ?? ""))
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_poison_delivery")
			const userId = asUserId("user_poison_delivery")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const insert = (n: number, eventType: string) =>
				Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-00000000040${n}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey: `poison-${n}`,
						eventType,
						attemptNumber: 1,
						status: "queued",
						// The corrupt row is the oldest, so it is claimed first.
						scheduledAt: fixedTime - 10 + n,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: `poison-${n}`,
							observed: { value: 0, sampleCount: 0 },
						}),
					}),
				)
			yield* insert(1, "not-an-event-type")
			yield* insert(2, "test")

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const statuses = yield* Effect.promise(() =>
				queryFirstRow<{ summary: string }>(
					testDb,
					`select string_agg(delivery_key || '=' || status, ',' order by delivery_key) as summary
					 from alert_delivery_events where delivery_key like 'poison-%'`,
					[],
				),
			)
			// Failed once with its attempt time, and not re-queued: its stored
			// event type cannot be read, so the retry insert fails too.
			assert.strictEqual(statuses?.summary, "poison-1=failed,poison-2=success")
			const poison = yield* Effect.promise(() =>
				queryFirstRow<{ attempts: number; attemptedAt: Date | null }>(
					testDb,
					`select count(*)::int as attempts, max(attempted_at) as "attemptedAt"
					 from alert_delivery_events where delivery_key = 'poison-1'`,
					[],
				),
			)
			assert.strictEqual(poison?.attempts, 1)
			assert.isNotNull(poison?.attemptedAt ?? null)
			assert.lengthOf(sent, 1)
			const destinations = yield* alerts.listDestinations(orgId)
			assert.isTrue(destinations.destinations[0]?.enabled)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: fetchImpl,
				}),
			),
		)
	})
})

describe("AlertsService delivery drain", () => {
	it.effect("drains a burst larger than one batch in a single tick", () => {
		const fixedTime = 1_710_000_600_000
		const testDb = createTestDb(trackedDbs)
		const sent = { count: 0 }
		const countingFetch = (async () => {
			sent.count += 1
			return new Response("ok", { status: 200 })
		}) as typeof fetch

		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_drain_burst")
			const userId = asUserId("user_drain_burst")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* Effect.forEach(Arr.range(1, 60), (n) =>
				Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-${String(500 + n).padStart(12, "0")}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey: `burst-${n}`,
						eventType: "test",
						attemptNumber: 1,
						status: "queued",
						scheduledAt: fixedTime - 100 + n,
						payloadJson: JSON.stringify({
							eventType: "test",
							incidentId: null,
							incidentStatus: "resolved",
							dedupeKey: `burst-${n}`,
							observed: { value: 0, sampleCount: 0 },
						}),
					}),
				),
			)

			const tick = yield* alerts.runSchedulerTick()

			assert.strictEqual(sent.count, 60)
			assert.strictEqual(tick.processedCount, 60)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }), {
					fetch: countingFetch,
				}),
			),
		)
	})
})

describe("AlertsService chat digests", () => {
	const fixedTime = 1_710_000_900_000
	const workspaceId = Schema.decodeUnknownSync(ChatWorkspaceId)("44444444-4444-4444-8444-444444444444")

	/** Queues `count` trigger deliveries for one chat destination, runs a tick, and reads the queue. */
	const runBurst = (
		count: number,
		outcome: "posted" | "rate_limited" | "rejected",
		eventTypeOf: (n: number) => string = () => "trigger",
	) => {
		const testDb = createTestDb(trackedDbs)
		const posts: Array<string> = []
		const poster = Layer.succeed(ChatAlertPoster, {
			post: (request) =>
				Effect.suspend(() => {
					const card = request.blocks[0]
					posts.push(card?.kind === "alert" ? card.title : "")
					if (outcome === "posted")
						return Effect.succeed({
							connectorName: "Test Chat",
							messageId: `message-${posts.length}`,
						})
					const fields = {
						message: "Discord refused this message",
						destinationType: "chat" as const,
					}
					return Effect.fail(
						outcome === "rejected"
							? new AlertDeliveryRejectedError(fields)
							: new AlertDeliveryError(fields),
					)
				}),
			findChannel: () =>
				Effect.succeed({
					connector: Schema.decodeUnknownSync(ChatConnectorId)("testchat"),
					workspaceName: "Acme",
					channelName: "incidents",
				}),
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(fixedTime)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_chat_digest")
			const userId = asUserId("user_chat_digest")
			const destination = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "chat",
				name: "Incidents",
				workspaceId,
				channelId: "channel-1",
			})
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* Effect.forEach(Arr.range(1, count), (n) =>
				Effect.promise(() =>
					insertDeliveryEventRow(testDb, {
						id: `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`,
						orgId,
						incidentId: null,
						ruleId: rule.id,
						destinationId: destination.id,
						deliveryKey: `digest-${n}`,
						eventType: eventTypeOf(n),
						attemptNumber: 1,
						status: "queued",
						scheduledAt: fixedTime - 100 + n,
						payloadJson: JSON.stringify({
							eventType: eventTypeOf(n) === "test" ? "test" : "trigger",
							dedupeKey: `digest-${n}`,
						}),
					}),
				),
			)
			yield* alerts.runSchedulerTick()
			const queue = yield* Effect.promise(() =>
				queryFirstRow<{ summary: string }>(
					testDb,
					`select string_agg(status || '@' || attempt_number, ',' order by status, attempt_number) as summary
					 from alert_delivery_events where delivery_key like 'digest-%'`,
					[],
				),
			)
			const health = yield* Effect.promise(() =>
				queryFirstRow<{ failures: number; enabled: boolean }>(
					testDb,
					"select consecutive_failures as failures, enabled from alert_destinations where id = $1",
					[destination.id],
				),
			)
			return { posts, queue: queue?.summary ?? "", health }
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
	}

	it.effect("sends a burst of five for one channel as one digest and delivers every row", () =>
		Effect.gen(function* () {
			const { posts, queue } = yield* runBurst(5, "posted")
			assert.deepStrictEqual(posts, ["\u{1F514} 5 alert notifications"])
			assert.strictEqual(queue, Array(5).fill("success@1").join(","))
		}),
	)

	it.effect("keeps two deliveries as two ordinary messages", () =>
		Effect.gen(function* () {
			const { posts, queue } = yield* runBurst(2, "posted")
			assert.lengthOf(posts, 2)
			assert.notInclude(posts.join(","), "alert notifications")
			assert.strictEqual(queue, "success@1,success@1")
		}),
	)

	it.effect("counts a refused digest as one destination failure, not one per row", () =>
		Effect.gen(function* () {
			const { posts, queue, health } = yield* runBurst(4, "rejected")
			assert.lengthOf(posts, 1)
			assert.strictEqual(queue, Array(4).fill("failed@1").join(","))
			assert.strictEqual(health?.failures, 1)
			assert.isTrue(health?.enabled)
		}),
	)

	it.effect("finishes every row of a failed digest even when one row's recovery fails", () =>
		Effect.gen(function* () {
			// The first row's stored event type cannot be read, so its retry insert fails.
			const { queue } = yield* runBurst(4, "rate_limited", (n) =>
				n === 1 ? "not-an-event-type" : "trigger",
			)
			assert.strictEqual(queue, [...Array(4).fill("failed@1"), ...Array(3).fill("queued@2")].join(","))
		}),
	)

	it.effect("posts a digest where its first row sits in the batch, after earlier deliveries", () =>
		Effect.gen(function* () {
			const { posts } = yield* runBurst(5, "posted", (n) => (n === 1 ? "test" : "trigger"))
			assert.lengthOf(posts, 2)
			assert.notInclude(posts[0], "alert notifications")
			assert.strictEqual(posts[1], "\u{1F514} 4 alert notifications")
		}),
	)

	it.effect("leaves every row of a failed digest queued for a retry", () =>
		Effect.gen(function* () {
			const { posts, queue } = yield* runBurst(5, "rate_limited")
			assert.lengthOf(posts, 1)
			assert.strictEqual(queue, [...Array(5).fill("failed@1"), ...Array(5).fill("queued@2")].join(","))
		}),
	)
})

describe("alert incident open uniqueness", () => {
	const insertOpenIncident = (testDb: TestDb, id: string, status = "open") =>
		executeSql(
			testDb,
			`
        insert into alert_incidents (
          id, org_id, rule_id, incident_key, rule_name, group_key, signal_type,
          severity, status, comparator, threshold, first_triggered_at,
          last_triggered_at, dedupe_key, created_at, updated_at
        ) values (
          $1, 'org_unique', 'rule_unique', $1, 'Rule', 'checkout', 'error_rate',
          'critical', $2, 'gt', 5, now(), now(), 'org_unique:rule_unique:checkout',
          now(), now()
        )
      `,
			[id, status],
		)

	it.effect("rejects a second open incident for the same (rule, group)", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() => insertOpenIncident(testDb, "inc-open-1"))
			// The partial unique index is the backstop for an expired scheduler
			// claim: two overlapping ticks can both decide to open, but only one
			// row can exist.
			const second = yield* Effect.promise(() =>
				insertOpenIncident(testDb, "inc-open-2").then(
					() => "inserted" as const,
					() => "conflict" as const,
				),
			)
			assert.strictEqual(second, "conflict")

			// Resolved history does not participate: after resolving the first,
			// a new open incident for the same key is legal again.
			yield* Effect.promise(() =>
				executeSql(testDb, "update alert_incidents set status = 'resolved' where id = $1", [
					"inc-open-1",
				]),
			)
			const third = yield* Effect.promise(() =>
				insertOpenIncident(testDb, "inc-open-3").then(
					() => "inserted" as const,
					() => "conflict" as const,
				),
			)
			assert.strictEqual(third, "inserted")
		})
	})
})

describe("AlertsService held incidents", () => {
	const DAY_MS = 24 * 60 * 60_000

	/** A `service_operations_minutely` liveness row for one probe window. */
	const livenessRow = (spanCount: number): Record<string, unknown> => ({
		minutesWithData: spanCount > 0 ? 5 : 0,
		spanCount,
		estimatedSpanCount: spanCount,
		errorCount: 0,
		estimatedErrorCount: 0,
		lastSeen: "2023-11-14 22:13:00",
	})

	/** The `startTime` literal of a compiled liveness query, as epoch ms. */
	const probeWindowStartMs = (sql: string): number | null => {
		const match = />= '(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})'/.exec(sql)
		return match?.[1] === undefined ? null : Date.parse(`${match[1].replace(" ", "T")}Z`)
	}

	/**
	 * Which of the three probe windows a start time names, and its count. The
	 * observed window is exactly one rule window (5m) back from the tick; the
	 * onset baseline ends at incident onset, which is at least a minute earlier.
	 */
	const probeCount = (liveness: LivenessState, startMs: number, service?: string): number =>
		startMs <= liveness.nowMs - 23 * 60 * 60_000
			? liveness.priorDay
			: startMs >= liveness.nowMs - 5 * 60_000 - 1_000
				? ((service === undefined ? undefined : liveness.observedByService?.[service]) ??
					liveness.observed)
				: liveness.onset

	interface LivenessState {
		/** Span count for the quiet window ending at the tick. */
		observed: number
		/** Per-service override of `observed`, for a loud sibling next to a dark service. */
		observedByService?: Record<string, number>
		/** Span count for the window ending at incident onset. */
		onset: number
		/** Span count for the same window yesterday; 0 for a service with no prior day. */
		priorDay: number
		/** Make every liveness probe fail, so the verdict is `probe_failed`. */
		failProbe: boolean
		/** The test clock, mirrored so the stub can tell the three windows apart. */
		nowMs: number
	}

	/**
	 * Routes the rule's own evaluation to `rows` and every liveness probe to the
	 * window-specific counts in `liveness`, telling the windows apart by their
	 * start time: yesterday is a day back, observed ends at the tick, and
	 * anything else is the onset baseline.
	 */
	const makeLivenessStub = (state: {
		rows: ReadonlyArray<Record<string, unknown>>
		liveness: LivenessState
	}): WarehouseQueryServiceApi => {
		const evaluationRows = () => Effect.succeed(state.rows)
		// A `serviceNames` rule evaluates one service-filtered plan per service;
		// honour that filter so a silent service really sees an empty window.
		const rowsForQuery = (sql: string) => {
			const scoped = /ServiceName (?:= '([^']+)'|IN \('([^']+)'\))/.exec(sql)
			const service = scoped?.[1] ?? scoped?.[2]
			return service === undefined ? state.rows : state.rows.filter((row) => row.groupName === service)
		}
		return {
			...makeWarehouseStub({ tracesAggregateRows: emptyWarehouseRows }),
			warmRoute: () => Effect.void,
			sqlQuery: evaluationRows,
			rawSqlQuery: evaluationRows,
			compiledQuery: (_tenant, compiled) =>
				Effect.gen(function* () {
					const query = compiledQueryOf(compiled)
					// The org-wide pulse (a rule with no service scope): same counts,
					// union shape.
					if (query.sql.includes("service_overview_spans")) {
						const startMs = probeWindowStartMs(query.sql) ?? state.liveness.nowMs
						return yield* query
							.decodeRows([
								{ signal: "spans", count: probeCount(state.liveness, startMs), lastSeen: "" },
							])
							.pipe(Effect.orDie)
					}
					return yield* query.decodeRows(rowsForQuery(query.sql)).pipe(Effect.orDie)
				}),
			compiledQueryWithCapabilities: (_tenant, compile) => {
				const query = Effect.runSync(compile(baselineWarehouseCapabilities()))
				return query.decodeRows(rowsForQuery(query.sql)).pipe(Effect.orDie)
			},
			compiledQueryFirst: (_tenant, compiled) =>
				Effect.gen(function* () {
					const query = compiledQueryOf(compiled)
					if (!query.sql.includes("service_operations_minutely")) {
						return yield* query.decodeFirstRow(state.rows).pipe(Effect.orDie)
					}
					if (state.liveness.failProbe) {
						return yield* Effect.fail(
							new WarehouseQueryError({ message: "probe failed", pipeName: "liveness" }),
						)
					}
					const startMs = probeWindowStartMs(query.sql) ?? state.liveness.nowMs
					const service = /ServiceName = '([^']+)'/.exec(query.sql)?.[1]
					return yield* query
						.decodeFirstRow([livenessRow(probeCount(state.liveness, startMs, service))])
						.pipe(Effect.orDie)
				}),
		}
	}

	const breaching = (groupName: string) =>
		tracesRow({ groupName, count: 500, errorRate: 42, estimatedSpanCount: 500 })

	/**
	 * Grouped by service, both groups breaching, one incident each after a
	 * single tick. A group that drops out of the results is an orphan; a
	 * `serviceNames` rule evaluates each service on its own instead and lands
	 * in the skipped path — see the multi-service test below.
	 */
	const createTwoServiceRule = (
		alerts: AlertsServiceApi,
		orgId: ReturnType<typeof asOrgId>,
		userId: ReturnType<typeof asUserId>,
		destinationId: AlertDestinationId,
		scope: { groupBy: ["service.name"] } | { serviceNames: ["checkout", "payments"] } = {
			groupBy: ["service.name"],
		},
	) =>
		alerts.createRule(
			orgId,
			userId,
			adminRoles,
			new AlertRuleUpsertRequest({
				name: "Grouped error rate",
				severity: "critical",
				enabled: true,
				...scope,
				signalType: "error_rate",
				comparator: "gt",
				threshold: 5,
				windowMinutes: 5,
				minimumSampleCount: 10,
				consecutiveBreachesRequired: 1,
				consecutiveHealthyRequired: 1,
				renotifyIntervalMinutes: 30,
				destinationIds: [destinationId],
			}),
		)

	const tickAfter = (state: { liveness: LivenessState }, alerts: AlertsServiceApi, minutes: number) =>
		Effect.gen(function* () {
			yield* TestClock.adjust(Duration.minutes(minutes))
			state.liveness.nowMs = yield* Clock.currentTimeMillis
			yield* alerts.runSchedulerTick()
		})

	const paymentsIncident = (alerts: AlertsServiceApi, orgId: ReturnType<typeof asOrgId>) =>
		Effect.map(alerts.listIncidents(orgId), (list) => {
			const incident = list.incidents.find((i) => i.groupKey === "payments")
			assert.ok(incident, "payments incident missing")
			return incident
		})

	it.effect("holds an orphaned group whose traffic collapsed, then resolves at the ceiling", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			// Peak at onset, a thin evening now, no prior day to compare against.
			liveness: { observed: 19, onset: 172, priorDay: 0, failProbe: false, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_ceiling")
			const userId = asUserId("user_hold_ceiling")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 2)

			// payments vanishes from the results while its traffic is at 11% of onset.
			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)

			const held = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(held.status, "open")
			assert.strictEqual(held.holdReason, "volume_collapsed")
			assert.strictEqual(held.heldSince, new Date(DEFAULT_CLOCK_EPOCH_MS + 60_000).toISOString())
			assert.strictEqual(held.resolvedAt, null)
			const eventsWhileHeld = yield* alerts.listDeliveryEvents(orgId)
			assert.deepStrictEqual(
				eventsWhileHeld.events.map((e) => e.eventType),
				["trigger", "trigger"],
				"a hold must not notify",
			)

			// Still held short of the ceiling (max(3 × 5m, 30m) = 30m): same reason,
			// same clock.
			yield* tickAfter(state, alerts, 20)
			const stillHeld = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(stillHeld.status, "open")
			assert.strictEqual(stillHeld.heldSince, held.heldSince)

			// Past the ceiling the absence is believed and the incident resolves,
			// telling the destination why.
			yield* tickAfter(state, alerts, 10)
			const resolved = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(resolved.status, "resolved")
			assert.strictEqual(resolved.holdReason, null)
			assert.strictEqual(resolved.heldSince, null)
			// One resolve, for payments; checkout's 30-minute renotify is the only
			// other event in the meantime.
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.deepStrictEqual(
				events.events.map((e) => e.eventType).filter((type) => type !== "renotify"),
				["resolve", "trigger", "trigger"],
			)

			// The still-breaching group was never touched.
			const checkout = (yield* alerts.listIncidents(orgId)).incidents.find(
				(i) => i.groupKey === "checkout",
			)
			assert.strictEqual(checkout?.status, "open")
			assert.strictEqual(checkout?.holdReason, null)
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("resolves a held incident as soon as telemetry is back", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			liveness: { observed: 0, onset: 172, priorDay: 0, failProbe: false, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_return")
			const userId = asUserId("user_hold_return")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			// The service went completely dark: an outage, held for up to six hours.
			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			assert.strictEqual((yield* paymentsIncident(alerts, orgId)).holdReason, "no_data")

			// Traffic returns at its usual level and the group is still absent from
			// the results: the breach really is over.
			state.liveness.observed = 170
			yield* tickAfter(state, alerts, 1)
			const resolved = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(resolved.status, "resolved")
			assert.strictEqual(resolved.holdReason, null)
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("reads a nightly dip against yesterday night and resolves without a hold", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			// 19 now against 172 at onset would collapse; against 22 this hour
			// yesterday it is a normal night.
			liveness: { observed: 19, onset: 172, priorDay: 22, failProbe: false, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS + DAY_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS + DAY_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_prior_day")
			const userId = asUserId("user_hold_prior_day")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			const resolved = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(resolved.status, "resolved")
			assert.strictEqual(resolved.holdReason, null)
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("suppresses the resolve of an orphaned group whose trigger was flap-suppressed", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			liveness: { observed: 19, onset: 172, priorDay: 22, failProbe: false, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS + DAY_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS + DAY_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_orphan_flap")
			const userId = asUserId("user_orphan_flap")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			// Flap 1: the group drops out and its all-clear is delivered.
			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			// Flap 2 inside the renotify interval: the reopen's trigger is
			// suppressed, so its orphan resolve must stay quiet too.
			state.rows = [breaching("checkout"), breaching("payments")]
			yield* tickAfter(state, alerts, 1)
			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)

			const payments = (yield* alerts.listIncidents(orgId)).incidents.filter(
				(incident) => incident.groupKey === "payments",
			)
			assert.lengthOf(payments, 2)
			assert.isTrue(payments.every((incident) => incident.status === "resolved"))
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.deepStrictEqual(
				events.events.map((event: { eventType: string }) => event.eventType).sort(),
				["resolve", "trigger", "trigger"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("a breach ends the hold and a later hold starts a fresh clock", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			liveness: { observed: 19, onset: 172, priorDay: 0, failProbe: false, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_rebreach")
			const userId = asUserId("user_hold_rebreach")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			const firstHold = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(firstHold.holdReason, "volume_collapsed")

			// The breach comes back: same incident, hold cleared, no new trigger.
			state.rows = [breaching("checkout"), breaching("payments")]
			yield* tickAfter(state, alerts, 1)
			const rebreached = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(rebreached.id, firstHold.id)
			assert.strictEqual(rebreached.status, "open")
			assert.strictEqual(rebreached.holdReason, null)
			assert.strictEqual(rebreached.heldSince, null)
			assert.lengthOf((yield* alerts.listDeliveryEvents(orgId)).events, 2)

			// Quiet again 25 minutes later: the clock starts now, not at the first
			// hold, so this is nowhere near the 30-minute ceiling.
			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 25)
			const secondHold = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(secondHold.status, "open")
			assert.strictEqual(secondHold.heldSince, new Date(state.liveness.nowMs).toISOString())
			yield* tickAfter(state, alerts, 5)
			assert.strictEqual((yield* paymentsIncident(alerts, orgId)).status, "open")
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("gates a multi-service rule's silent service the same way as an orphaned group", () => {
		const testDb = createTestDb(trackedDbs)
		// `serviceNames` rules evaluate each service on its own, so a silent
		// service is a `skipped` evaluation on an open incident rather than an
		// orphan. Before the gate that froze the incident forever.
		// checkout stays loud throughout; only payments thins out. The probe must
		// scope to the quiet service: summed with checkout the ratio is 189/344 and
		// checkout's traffic would vouch for payments.
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			liveness: {
				observed: 19,
				observedByService: { checkout: 170 },
				onset: 172,
				priorDay: 0,
				failProbe: false,
				nowMs: 0,
			},
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_multi_service")
			const userId = asUserId("user_hold_multi_service")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id, {
				serviceNames: ["checkout", "payments"],
			})
			yield* alerts.runSchedulerTick()
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 2)

			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			const held = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(held.status, "open")
			assert.strictEqual(held.holdReason, "volume_collapsed")

			state.liveness.observedByService = { checkout: 170, payments: 170 }
			yield* tickAfter(state, alerts, 1)
			const resolved = yield* paymentsIncident(alerts, orgId)
			assert.strictEqual(resolved.status, "resolved")
			assert.strictEqual(resolved.holdReason, null)
			const events = yield* alerts.listDeliveryEvents(orgId)
			assert.deepStrictEqual(
				events.events.map((e) => e.eventType),
				["resolve", "trigger", "trigger"],
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})

	it.effect("never resolves on the clock while the probe itself is failing", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			rows: [breaching("checkout"), breaching("payments")],
			liveness: { observed: 172, onset: 172, priorDay: 0, failProbe: true, nowMs: 0 },
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			state.liveness.nowMs = DEFAULT_CLOCK_EPOCH_MS
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_hold_probe_failed")
			const userId = asUserId("user_hold_probe_failed")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			yield* createTwoServiceRule(alerts, orgId, userId, destination.id)
			yield* alerts.runSchedulerTick()

			state.rows = [breaching("checkout")]
			yield* tickAfter(state, alerts, 1)
			assert.strictEqual((yield* paymentsIncident(alerts, orgId)).holdReason, "probe_failed")

			// Seven hours of our own warehouse failing says nothing about their
			// traffic: still held.
			yield* tickAfter(state, alerts, 7 * 60)
			assert.strictEqual((yield* paymentsIncident(alerts, orgId)).status, "open")

			// The first successful probe decides.
			state.liveness.failProbe = false
			yield* tickAfter(state, alerts, 1)
			assert.strictEqual((yield* paymentsIncident(alerts, orgId)).status, "resolved")
		}).pipe(Effect.provide(makeLayer(testDb, makeLivenessStub(state), { fetch: okFetch })))
	})
})

describe("AlertsService evaluation cadence", () => {
	const createCadenceRule = (alerts: AlertsServiceApi, orgId: OrgId, windowMinutes: number) =>
		createWebhookDestination(alerts, orgId, asUserId("user_cadence")).pipe(
			Effect.flatMap((destination) =>
				alerts.createRule(
					orgId,
					asUserId("user_cadence"),
					adminRoles,
					new AlertRuleUpsertRequest({
						name: `Cadence ${windowMinutes}m`,
						severity: "warning",
						enabled: true,
						signalType: "error_rate",
						comparator: "gt",
						threshold: 5,
						windowMinutes,
						destinationIds: [destination.id],
					}),
				),
			),
		)

	// Runs `count` ticks a minute apart and returns each tick's evaluated count.
	const tickEveryMinute = (alerts: AlertsServiceApi, count: number) =>
		Effect.forEach(Arr.range(1, count), () =>
			alerts.runSchedulerTick().pipe(
				Effect.map((tick) => tick.evaluatedCount),
				Effect.tap(() => TestClock.adjust(Duration.minutes(1))),
			),
		)

	it.effect("checks a 15-minute rule every third minute and a 5-minute rule every minute", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createCadenceRule(alerts, asOrgId("org_cadence_short_a"), 5)
			yield* createCadenceRule(alerts, asOrgId("org_cadence_long"), 15)
			yield* createCadenceRule(alerts, asOrgId("org_cadence_short_b"), 5)

			const counts = yield* tickEveryMinute(alerts, 10)

			// Both 5-minute rules run every tick; the long rule adds one on its own minutes.
			const longTicks = Arr.filter(Arr.range(0, counts.length - 1), (index) => counts[index] === 3)
			assert.isTrue(counts.every((count) => count === 2 || count === 3))
			// The first tick runs it (never claimed), then it settles onto every third minute.
			assert.strictEqual(longTicks[0], 0)
			const settled = longTicks.slice(1)
			assert.isAtLeast(settled.length, 3)
			Arr.forEach(settled.slice(1), (tick, i) => assert.strictEqual(tick - settled[i]!, 3))
			assert.isAtMost(settled[0]!, 3)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	it.effect("checks an edited rule on the next tick instead of waiting for its slot", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_cadence_edit")
			const rule = yield* createCadenceRule(alerts, orgId, 30)
			const claimedAt = yield* Clock.currentTimeMillis
			yield* alerts.runSchedulerTick()

			// One of the next two minutes is off the rule's every-fifth-minute phase.
			const idle = [1, 2].find(
				(n) =>
					!isAlertRuleDue({
						ruleId: rule.id,
						intervalMinutes: 5,
						updatedAt: claimedAt,
						lastClaimedAt: claimedAt,
						windowEndMs: snapAlertWindowEndMs(claimedAt + n * 60_000),
					}),
			)!
			yield* TestClock.adjust(Duration.minutes(idle))
			// Back on an idle minute: an edit makes the rule due there.
			yield* alerts.updateRule(
				orgId,
				asUserId("user_cadence"),
				adminRoles,
				rule.id,
				new AlertRuleUpsertRequest({
					name: "Edited",
					severity: "warning",
					enabled: true,
					signalType: rule.signalType,
					comparator: rule.comparator,
					threshold: 10,
					windowMinutes: rule.windowMinutes,
					destinationIds: [...rule.destinationIds],
				}),
			)
			const afterEdit = yield* alerts.runSchedulerTick()
			assert.strictEqual(afterEdit.evaluatedCount, 1)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})
})

describe("AlertsService check intervals", () => {
	const RAW_SQL = "SELECT count() AS value FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)"

	// Records the settings each raw SQL query ran with.
	const recordingWarehouse = (settings: Array<WarehouseQuerySettings | undefined>) => {
		const stub = makeWarehouseStub({ rawQueryRows: [{ value: 1, samples: 1 }] })
		return {
			...stub,
			rawSqlQuery: (...args: Parameters<WarehouseQueryServiceApi["rawSqlQuery"]>) => {
				settings.push(args[2]?.settings)
				return stub.rawSqlQuery(...args)
			},
		} satisfies WarehouseQueryServiceApi
	}

	const createIntervalRule = (
		alerts: AlertsServiceApi,
		orgId: OrgId,
		rule: {
			readonly signalType: "raw_query" | "error_rate"
			readonly windowMinutes: number
			readonly evaluationIntervalMinutes: AlertEvaluationIntervalMinutes | null
		},
	) =>
		createWebhookDestination(alerts, orgId, asUserId("user_interval")).pipe(
			Effect.flatMap((destination) =>
				alerts.createRule(
					orgId,
					asUserId("user_interval"),
					adminRoles,
					new AlertRuleUpsertRequest({
						name: `Interval ${rule.signalType} ${rule.evaluationIntervalMinutes}`,
						severity: "warning",
						enabled: true,
						signalType: rule.signalType,
						...(rule.signalType === "raw_query" ? { rawQuerySql: RAW_SQL } : undefined),
						comparator: "gt",
						threshold: 5,
						windowMinutes: rule.windowMinutes,
						evaluationIntervalMinutes: rule.evaluationIntervalMinutes,
						destinationIds: [destination.id],
					}),
				),
			),
		)

	it.effect("runs a raw SQL rule checked every 10 minutes in the long-query lane with a 25s limit", () => {
		const testDb = createTestDb(trackedDbs)
		const settings: Array<WarehouseQuerySettings | undefined> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createIntervalRule(alerts, asOrgId("org_interval_long"), {
				signalType: "raw_query",
				windowMinutes: 10,
				evaluationIntervalMinutes: 10,
			})

			assert.strictEqual((yield* alerts.runSchedulerTick("standard")).evaluatedCount, 0)
			assert.strictEqual((yield* alerts.runSchedulerTick("long_query")).evaluatedCount, 1)
			assert.deepStrictEqual(settings, [{ maxExecutionTime: 25, maxMemoryUsage: 512_000_000 }])
		}).pipe(Effect.provide(makeLayer(testDb, recordingWarehouse(settings), { fetch: okFetch })))
	})

	it.effect("keeps a raw SQL rule checked every minute in the standard lane with a 5s limit", () => {
		const testDb = createTestDb(trackedDbs)
		const settings: Array<WarehouseQuerySettings | undefined> = []
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			yield* createIntervalRule(alerts, asOrgId("org_interval_short"), {
				signalType: "raw_query",
				windowMinutes: 5,
				evaluationIntervalMinutes: null,
			})

			assert.strictEqual((yield* alerts.runSchedulerTick("long_query")).evaluatedCount, 0)
			assert.strictEqual((yield* alerts.runSchedulerTick("standard")).evaluatedCount, 1)
			assert.deepStrictEqual(settings, [{ maxExecutionTime: 5, maxMemoryUsage: 256_000_000 }])
		}).pipe(Effect.provide(makeLayer(testDb, recordingWarehouse(settings), { fetch: okFetch })))
	})

	it.effect("checks a rule on the interval its author picked", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			// A 15-minute window alone would be checked every third minute.
			yield* createIntervalRule(alerts, asOrgId("org_interval_builder"), {
				signalType: "error_rate",
				windowMinutes: 15,
				evaluationIntervalMinutes: 10,
			})

			const counts = yield* Effect.forEach(Arr.range(1, 25), () =>
				alerts.runSchedulerTick().pipe(
					Effect.map((tick) => tick.evaluatedCount),
					Effect.tap(() => TestClock.adjust(Duration.minutes(1))),
				),
			)
			const ran = Arr.filter(Arr.range(0, counts.length - 1), (index) => counts[index] === 1)
			// Right away (never claimed), then on its phase minute every ten.
			assert.strictEqual(ran[0], 0)
			const settled = ran.slice(1)
			assert.isAtMost(settled[0]!, 10)
			assert.isAtLeast(settled.length, 2)
			Arr.forEach(settled.slice(1), (tick, i) => assert.strictEqual(tick - settled[i]!, 10))
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	it.effect("rejects a check interval longer than the window", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const exit = yield* createIntervalRule(alerts, asOrgId("org_interval_gap"), {
				signalType: "error_rate",
				windowMinutes: 5,
				evaluationIntervalMinutes: 15,
			}).pipe(Effect.exit)
			const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null
			assert.instanceOf(error, AlertValidationError)
			assert.include(
				error instanceof AlertValidationError ? error.details.join("\n") : "",
				"must be at least evaluationIntervalMinutes",
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub({}), { fetch: okFetch })))
	})

	// A raw SQL warehouse whose queries run 6s and time out while `failing` holds.
	const timingOutWarehouse = (state: {
		failing: boolean
		readonly limits: Array<number | undefined>
		readonly checkDurations: Array<unknown>
	}) => {
		const stub = makeWarehouseStub({ rawQueryRows: [{ value: 1, samples: 1 }] })
		return {
			...stub,
			rawSqlQuery: (...args: Parameters<WarehouseQueryServiceApi["rawSqlQuery"]>) =>
				Effect.gen(function* () {
					state.limits.push(args[2]?.settings?.maxExecutionTime)
					yield* TestClock.adjust(Duration.seconds(6))
					if (!state.failing) return yield* stub.rawSqlQuery(...args)
					return yield* new WarehouseQuotaExceededError({
						message: "Timeout exceeded: elapsed 6000 ms",
						pipeName: "rawSqlQuery",
						setting: "max_execution_time",
					})
				}),
			ingest: (_tenant, datasource, rows) =>
				Effect.sync(() => {
					if (datasource === "alert_checks") {
						state.checkDurations.push(...rows.map((row) => row.EvaluationDurationMs))
					}
				}),
		} satisfies WarehouseQueryServiceApi
	}

	// Both lanes, once a minute.
	const tickBothLanes = (alerts: AlertsServiceApi, minutes: number) =>
		Effect.forEach(
			Arr.range(1, minutes),
			() =>
				alerts
					.runSchedulerTick("standard")
					.pipe(
						Effect.andThen(alerts.runSchedulerTick("long_query")),
						Effect.andThen(TestClock.adjust(Duration.minutes(1))),
					),
			{ discard: true },
		)

	it.effect("slows a rule whose query keeps timing out, a step at a time, up to its window", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			limits: [] as Array<number | undefined>,
			checkDurations: [] as Array<unknown>,
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_slowdown")
			// Checked every 2 minutes by its window, under the 5s limit.
			yield* createIntervalRule(alerts, orgId, {
				signalType: "raw_query",
				windowMinutes: 10,
				evaluationIntervalMinutes: null,
			})

			yield* tickBothLanes(alerts, 60)

			// Three timeouts at each limit, then 5-minute checks at 15s, then 10-minute checks at 25s.
			assert.deepStrictEqual(state.limits.slice(0, 9), [5, 5, 5, 15, 15, 15, 25, 25, 25])
			// The window caps it: 15 minutes would leave data unread between checks.
			assert.isTrue(state.limits.slice(6).every((limit) => limit === 25))
			assert.isAtMost(state.limits.length, 3 + 3 + 6)
			const [rule] = (yield* alerts.listRules(orgId)).rules
			assert.strictEqual(rule?.slowedIntervalMinutes, 10)
			assert.isNotNull(rule?.slowedAt)
			assert.strictEqual(rule?.lastEvaluationErrorKind, "query_too_slow")
			// A failed check records how long its query ran, not 0.
			assert.isNotEmpty(state.checkDurations)
			assert.isTrue(state.checkDurations.every((ms) => ms === 6000))
		}).pipe(Effect.provide(makeLayer(testDb, timingOutWarehouse(state), { fetch: okFetch })))
	})

	it.effect("does not slow a rule whose timeouts a clean check interrupts", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			limits: [] as Array<number | undefined>,
			checkDurations: [] as Array<unknown>,
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_slowdown_reset")
			yield* createIntervalRule(alerts, orgId, {
				signalType: "raw_query",
				windowMinutes: 5,
				evaluationIntervalMinutes: null,
			})

			yield* tickBothLanes(alerts, 2)
			state.failing = false
			yield* tickBothLanes(alerts, 1)
			state.failing = true
			yield* tickBothLanes(alerts, 2)

			assert.deepStrictEqual(state.limits, [5, 5, 5, 5, 5])
			const [rule] = (yield* alerts.listRules(orgId)).rules
			assert.isNull(rule?.slowedIntervalMinutes)
		}).pipe(Effect.provide(makeLayer(testDb, timingOutWarehouse(state), { fetch: okFetch })))
	})

	it.effect("gives a slowed rule its own interval back when it is edited", () => {
		const testDb = createTestDb(trackedDbs)
		const state = {
			failing: true,
			limits: [] as Array<number | undefined>,
			checkDurations: [] as Array<unknown>,
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_slowdown_edit")
			const created = yield* createIntervalRule(alerts, orgId, {
				signalType: "raw_query",
				windowMinutes: 5,
				evaluationIntervalMinutes: null,
			})
			yield* tickBothLanes(alerts, 3)
			assert.strictEqual((yield* alerts.listRules(orgId)).rules[0]?.slowedIntervalMinutes, 5)

			yield* alerts.updateRule(
				orgId,
				asUserId("user_interval"),
				adminRoles,
				created.id,
				new AlertRuleUpsertRequest({
					name: "Faster query",
					severity: "warning",
					signalType: "raw_query",
					rawQuerySql: RAW_SQL,
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					destinationIds: [...created.destinationIds],
				}),
			)
			state.failing = false
			state.limits.length = 0
			yield* tickBothLanes(alerts, 3)

			assert.deepStrictEqual(state.limits, [5, 5, 5])
			assert.isNull((yield* alerts.listRules(orgId)).rules[0]?.slowedIntervalMinutes)
		}).pipe(Effect.provide(makeLayer(testDb, timingOutWarehouse(state), { fetch: okFetch })))
	})
})

describe("AlertsService scheduler pool", () => {
	const RULE_COUNT = 50
	const SLOW_EVAL_MS = 3_000
	const FAST_EVAL_MS = 20

	type EvalDelay = Duration.Duration | "stuck"

	// A warehouse whose latency is chosen per org, one rule per org, so each rule's
	// evaluation time is set by the test. Records every org it was queried for.
	const makeSlowWarehouse = (delayFor: (orgId: string) => Effect.Effect<EvalDelay>) => {
		const queried = Ref.makeUnsafe(HashSet.empty<string>())
		const base = makeWarehouseStub({})
		const delayed = <A, E, R>(orgId: string, effect: Effect.Effect<A, E, R>) =>
			Ref.update(queried, HashSet.add(orgId)).pipe(
				Effect.andThen(delayFor(orgId)),
				Effect.flatMap((delay) => (delay === "stuck" ? Effect.never : Effect.sleep(delay))),
				Effect.andThen(effect),
			)
		const stub: WarehouseQueryServiceApi = {
			...base,
			sqlQuery: (tenant, ...rest) => delayed(tenant.orgId, base.sqlQuery(tenant, ...rest)),
			rawSqlQuery: (tenant, ...rest) => delayed(tenant.orgId, base.rawSqlQuery(tenant, ...rest)),
			compiledQuery: (tenant, ...rest) => delayed(tenant.orgId, base.compiledQuery(tenant, ...rest)),
			compiledQueryWithCapabilities: (tenant, ...rest) =>
				delayed(tenant.orgId, base.compiledQueryWithCapabilities(tenant, ...rest)),
			compiledQueryFirst: (tenant, ...rest) =>
				delayed(tenant.orgId, base.compiledQueryFirst(tenant, ...rest)),
		}
		return { stub, queried: Ref.get(queried) }
	}

	const orgAt = (index: number) => asOrgId(`org_pool_${String(index).padStart(2, "0")}`)

	// Created in index order with distinct updatedAt, which is the scheduler's order
	// for rules it has never claimed.
	const createPoolRules = (alerts: AlertsServiceApi) =>
		Effect.forEach(
			Arr.range(0, RULE_COUNT - 1),
			(index) =>
				createWebhookDestination(alerts, orgAt(index), asUserId("user_pool")).pipe(
					Effect.flatMap((destination) =>
						alerts.createRule(
							orgAt(index),
							asUserId("user_pool"),
							adminRoles,
							new AlertRuleUpsertRequest({
								name: "Pool rule",
								severity: "warning",
								enabled: true,
								signalType: "error_rate",
								comparator: "gt",
								threshold: 5,
								windowMinutes: 5,
								destinationIds: [destination.id],
							}),
						),
					),
					Effect.andThen(Effect.sleep("2 millis")),
				),
			{ discard: true },
		)

	const timedTick = (alerts: AlertsServiceApi) =>
		Effect.gen(function* () {
			const startedAt = yield* Clock.currentTimeMillis
			yield* alerts.runSchedulerTick()
			return (yield* Clock.currentTimeMillis) - startedAt
		})

	it.live("a slow rule holds one lane, not the whole claim chunk", () => {
		const testDb = createTestDb(trackedDbs)
		// 25 apart, so the two slow rules land in different claim chunks: a chunk
		// barrier would run them back to back.
		const { stub } = makeSlowWarehouse((orgId) =>
			Effect.succeed(
				orgId === orgAt(0) || orgId === orgAt(25)
					? Duration.millis(SLOW_EVAL_MS)
					: Duration.millis(FAST_EVAL_MS),
			),
		)
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const wallMs = yield* timedTick(alerts)

			assert.isBelow(wallMs, SLOW_EVAL_MS * 1.5)
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	})

	// Records when each org's first warehouse query started, i.e. when its rule began evaluating.
	const makeStartRecorder = () => {
		const firstQueryAt = Ref.makeUnsafe(HashMap.empty<string, number>())
		const { stub } = makeSlowWarehouse((orgId) =>
			Clock.currentTimeMillis.pipe(
				Effect.tap((ms) =>
					Ref.update(firstQueryAt, (starts) =>
						HashMap.has(starts, orgId) ? starts : HashMap.set(starts, orgId, ms),
					),
				),
				Effect.as(Duration.millis(FAST_EVAL_MS)),
			),
		)
		const startOffsets = (tickStartedAt: number) =>
			Ref.get(firstQueryAt).pipe(
				Effect.map((starts) =>
					Arr.map(Arr.range(0, RULE_COUNT - 1), (index) =>
						Option.match(HashMap.get(starts, orgAt(index)), {
							onNone: () => Number.NaN,
							onSome: (ms) => ms - tickStartedAt,
						}),
					),
				),
			)
		return { stub, startOffsets }
	}

	it.live("spaces rule starts evenly across the spread", () => {
		const testDb = createTestDb(trackedDbs)
		const spreadMs = 1_000
		const { stub, startOffsets } = makeStartRecorder()
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const startedAt = yield* Clock.currentTimeMillis
			const tick = yield* alerts.runSchedulerTick()
			const offsets = yield* startOffsets(startedAt)

			assert.strictEqual(tick.evaluatedCount, RULE_COUNT)
			assert.strictEqual(tick.deferredCount, 0)
			// Rule i waits for its slot at i * spreadMs / RULE_COUNT. The upper bound is from the
			// first start, so the tick's setup before the spread is not counted against the slack.
			const slotMs = spreadMs / RULE_COUNT
			Arr.forEach(offsets, (offset, index) => {
				assert.isAtLeast(offset, index * slotMs)
				assert.isBelow(offset - offsets[0]!, index * slotMs + 500)
			})
		}).pipe(
			Effect.provide(makeLayer(testDb, stub, { fetch: okFetch, schedulerSpreadMs: () => spreadMs })),
		)
	})

	it.live("shortens the spread to fit the tick deadline instead of deferring rules", () => {
		const testDb = createTestDb(trackedDbs)
		// 10 s of the 11 s budget stays clear at the end, so 1 s is left to spread over.
		const roomMs = 1_000
		const { stub, startOffsets } = makeStartRecorder()
		const { spans, tracer } = makeRecordingTracer()
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const startedAt = yield* Clock.currentTimeMillis
			const tick = yield* alerts.runSchedulerTick().pipe(Effect.withTracer(tracer))
			const offsets = yield* startOffsets(startedAt)

			assert.strictEqual(tick.evaluatedCount, RULE_COUNT)
			assert.strictEqual(tick.deferredCount, 0)
			assert.isBelow(Math.max(...offsets) - Math.min(...offsets), roomMs + 500)
			// The tick span reports the spread it actually used, not the configured 60 s.
			const [reported] = spansNamed(spans, "AlertsService.evaluateScheduledRules").map((span) =>
				span.attributes.get("maple.alerting.spread_ms"),
			)
			assert.isAbove(Number(reported), 0)
			assert.isAtMost(Number(reported), roomMs)
		}).pipe(
			Effect.provide(
				makeLayer(testDb, stub, {
					fetch: okFetch,
					schedulerTickBudgetMs: () => 10_000 + roomMs,
					schedulerSpreadMs: () => 60_000,
				}),
			),
		)
	})

	it.live("claims each chunk only when its first rule's slot comes up", () => {
		const testDb = createTestDb(trackedDbs)
		const spreadMs = 2_000
		const { stub, startOffsets } = makeStartRecorder()
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const startedAt = yield* Clock.currentTimeMillis
			yield* alerts.runSchedulerTick()
			const offsets = yield* startOffsets(startedAt)
			const claims = yield* Effect.promise(() =>
				testDb.pglite.query<{ orgId: string; claimedAt: Date }>(
					`select org_id as "orgId", last_scheduled_at as "claimedAt" from alert_rule_claims`,
				),
			)
			const claimOffset = new Map(
				claims.rows.map((row) => [row.orgId, row.claimedAt.getTime() - startedAt]),
			)

			// A claim is never older than one chunk of slots when its rule starts, so the
			// second chunk is claimed about halfway through the spread, not up front.
			const chunkSpanMs = (spreadMs / RULE_COUNT) * 25
			Arr.forEach(offsets, (offset, index) => {
				const claimedAt = claimOffset.get(orgAt(index))
				assert.isDefined(claimedAt)
				assert.isAtMost(claimedAt!, offset)
				assert.isBelow(offset - claimedAt!, chunkSpanMs + 500)
			})
			assert.isAtLeast(claimOffset.get(orgAt(25))!, chunkSpanMs - 100)
		}).pipe(
			Effect.provide(makeLayer(testDb, stub, { fetch: okFetch, schedulerSpreadMs: () => spreadMs })),
		)
	})

	it.live("a stuck rule holds one lane while the rest keep their slots", () => {
		const testDb = createTestDb(trackedDbs)
		const spreadMs = 1_000
		const firstQueryAt = Ref.makeUnsafe(HashMap.empty<string, number>())
		const { stub } = makeSlowWarehouse((orgId) =>
			Clock.currentTimeMillis.pipe(
				Effect.tap((ms) =>
					Ref.update(firstQueryAt, (starts) =>
						HashMap.has(starts, orgId) ? starts : HashMap.set(starts, orgId, ms),
					),
				),
				Effect.as<EvalDelay>(orgId === orgAt(0) ? "stuck" : Duration.millis(FAST_EVAL_MS)),
			),
		)
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const startedAt = yield* Clock.currentTimeMillis
			const tick = yield* alerts.runSchedulerTick()
			const starts = yield* Ref.get(firstQueryAt)

			assert.strictEqual(tick.evaluatedCount, RULE_COUNT)
			assert.strictEqual(tick.deferredCount, 0)
			const slotMs = spreadMs / RULE_COUNT
			const firstStart = Option.getOrThrow(HashMap.get(starts, orgAt(0)))
			Arr.forEach(Arr.range(1, RULE_COUNT - 1), (index) => {
				const offset = Option.getOrThrow(HashMap.get(starts, orgAt(index))) - startedAt
				assert.isAtLeast(offset, index * slotMs)
				assert.isBelow(offset - (firstStart - startedAt), index * slotMs + 500)
			})
			const stuckRule = (yield* alerts.listRules(orgAt(0))).rules[0]!
			assert.include(stuckRule.lastEvaluationError ?? "", "exceeded")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, stub, {
					fetch: okFetch,
					schedulerSpreadMs: () => spreadMs,
					schedulerEvalTimeoutMs: () => 1_500,
				}),
			),
		)
	})

	it.live("keeps at most two rules in flight when the spread outpaces evaluation", () => {
		const testDb = createTestDb(trackedDbs)
		// 40 ms slots against 20 ms evaluations: unpaced, all five lanes fill at once.
		const spreadMs = 2_000
		const inFlight = Ref.makeUnsafe(0)
		const peak = Ref.makeUnsafe(0)
		const base = makeSlowWarehouse(() => Effect.succeed(Duration.millis(FAST_EVAL_MS)))
		const tracked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.acquireUseRelease(
				Ref.updateAndGet(inFlight, (n) => n + 1).pipe(
					Effect.tap((n) => Ref.update(peak, (max) => Math.max(max, n))),
				),
				() => effect,
				() => Ref.update(inFlight, (n) => n - 1),
			)
		const stub: WarehouseQueryServiceApi = {
			...base.stub,
			sqlQuery: (...args) => tracked(base.stub.sqlQuery(...args)),
			rawSqlQuery: (...args) => tracked(base.stub.rawSqlQuery(...args)),
			compiledQuery: (...args) => tracked(base.stub.compiledQuery(...args)),
			compiledQueryWithCapabilities: (...args) =>
				tracked(base.stub.compiledQueryWithCapabilities(...args)),
			compiledQueryFirst: (...args) => tracked(base.stub.compiledQueryFirst(...args)),
		}
		const runTick = (spread: number) =>
			Effect.gen(function* () {
				yield* Ref.set(peak, 0)
				const alerts = yield* AlertsService
				const tick = yield* alerts.runSchedulerTick()
				assert.strictEqual(tick.evaluatedCount, RULE_COUNT)
				return yield* Ref.get(peak)
			}).pipe(
				Effect.provide(makeLayer(testDb, stub, { fetch: okFetch, schedulerSpreadMs: () => spread })),
			)
		return Effect.gen(function* () {
			yield* Effect.gen(function* () {
				yield* createPoolRules(yield* AlertsService)
			}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
			// Each tick is a minute after the last, past every claim's TTL.
			const unpacedPeak = yield* runTick(0)
			yield* Effect.promise(() =>
				testDb.pglite.query(
					`update alert_rule_claims set last_scheduled_at = last_scheduled_at - interval '2 minutes'`,
				),
			)
			const pacedPeak = yield* runTick(spreadMs)

			assert.strictEqual(unpacedPeak, 5)
			assert.isAtMost(pacedPeak, 2)
		})
	})

	it.live(
		"every rule in a tick reads and records the same window, even when the spread crosses a minute",
		() => {
			const testDb = createTestDb(trackedDbs)
			const shiftMs = Ref.makeUnsafe(0)
			const shiftedNow = Effect.zipWith(
				Clock.currentTimeMillis,
				Ref.get(shiftMs),
				(ms, shift) => ms + shift,
			)
			// The latest 'YYYY-MM-DD HH:MM:SS' literal in a rule's SQL is its window end.
			const windowEnds = Ref.makeUnsafe(HashMap.empty<string, string>())
			const recordWindowEnd = (orgId: string, sql: string) =>
				Ref.update(windowEnds, (ends) => {
					const latest = Arr.last(
						Arr.sort(sql.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g) ?? [], Order.String),
					)
					return Option.match(latest, {
						onNone: () => ends,
						onSome: (end) => HashMap.set(ends, orgId, end),
					})
				})
			const base = makeSlowWarehouse(() => Effect.succeed(Duration.millis(FAST_EVAL_MS)))
			const decodeCheckWindow = Schema.decodeUnknownSync(
				Schema.Struct({ WindowStart: Schema.String, WindowEnd: Schema.String }),
			)
			const checkWindows = Ref.makeUnsafe<ReadonlyArray<string>>([])
			const stub: WarehouseQueryServiceApi = {
				...base.stub,
				ingest: (_tenant, datasource, rows) =>
					datasource === "alert_checks"
						? Ref.update(checkWindows, (windows) => [
								...windows,
								...rows.map((row) => {
									const { WindowStart, WindowEnd } = decodeCheckWindow(row)
									return `${WindowStart} - ${WindowEnd}`
								}),
							])
						: Effect.void,
				compiledQuery: (tenant, compiled, ...rest) =>
					recordWindowEnd(tenant.orgId, compiledQueryOf(compiled).sql).pipe(
						Effect.andThen(base.stub.compiledQuery(tenant, compiled, ...rest)),
					),
				compiledQueryWithCapabilities: (tenant, compile, ...rest) =>
					recordWindowEnd(
						tenant.orgId,
						Effect.runSync(compile(baselineWarehouseCapabilities())).sql,
					).pipe(Effect.andThen(base.stub.compiledQueryWithCapabilities(tenant, compile, ...rest))),
			}
			return Effect.gen(function* () {
				const alerts = yield* AlertsService
				yield* createPoolRules(alerts)

				// Start the tick 1.5 s before a minute boundary, so a 2 s spread crosses it.
				const realNow = yield* Clock.currentTimeMillis
				const tickAt = (Math.floor(realNow / 60_000) + 2) * 60_000 - 1_500
				yield* Ref.set(shiftMs, tickAt - realNow)
				const tick = yield* alerts.runSchedulerTick()

				assert.strictEqual(tick.evaluatedCount, RULE_COUNT)
				const ends = Arr.fromIterable(HashMap.values(yield* Ref.get(windowEnds)))
				assert.strictEqual(ends.length, RULE_COUNT)
				assert.deepStrictEqual(Arr.dedupe(ends), [formatWarehouseDateTime(tickAt - 58_500)])
				// The audit rows name that same window, not each rule's later claim time.
				const windows = yield* Ref.get(checkWindows)
				assert.strictEqual(windows.length, RULE_COUNT)
				assert.lengthOf(Arr.dedupe(windows), 1)
				assert.include(windows[0]!, formatWarehouseDateTime(tickAt - 58_500))
			}).pipe(
				Effect.provide(
					makeLayer(testDb, stub, {
						fetch: okFetch,
						now: shiftedNow,
						schedulerSpreadMs: () => 2_000,
					}),
				),
			)
		},
	)

	it.live("stops at the tick deadline and leads the next tick with the deferred rules", () => {
		const testDb = createTestDb(trackedDbs)
		const tickBudgetMs = 1_500
		const shiftMs = Ref.makeUnsafe(0)
		// Slow on every tick, so no tick reaches all rules and only the order decides
		// which rules a tick reaches.
		const { stub, queried } = makeSlowWarehouse((orgId) =>
			Effect.succeed<EvalDelay>(orgId === orgAt(0) ? "stuck" : Duration.millis(200)),
		)
		const overrides = {
			fetch: okFetch,
			now: Effect.zipWith(Clock.currentTimeMillis, Ref.get(shiftMs), (ms, shift) => ms + shift),
			schedulerTickBudgetMs: () => tickBudgetMs,
			schedulerEvalTimeoutMs: () => 800,
		}
		const { spans, tracer } = makeRecordingTracer()
		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			yield* createPoolRules(alerts)

			const startedAt = yield* Clock.currentTimeMillis
			const firstTick = yield* alerts.runSchedulerTick().pipe(Effect.withTracer(tracer))
			const wallMs = (yield* Clock.currentTimeMillis) - startedAt

			// The deferred rules are counted on the tick span, where tick dashboards look.
			assert.isAbove(firstTick.deferredCount, 0)
			assert.deepStrictEqual(
				spansNamed(spans, "AlertsService.runSchedulerTick").map((span) =>
					span.attributes.get("maple.alerting.rules_deferred"),
				),
				[firstTick.deferredCount],
			)

			// Slack for a loaded CI runner; without the deadline the stuck rule never returns.
			assert.isBelow(wallMs, tickBudgetMs + 2_500)
			assert.isBelow(HashSet.size(yield* queried), RULE_COUNT)
			assert.strictEqual(firstTick.evaluatedCount, HashSet.size(yield* queried))
			const stuckRule = (yield* alerts.listRules(orgAt(0))).rules[0]!
			assert.include(stuckRule.lastEvaluationError ?? "", "deadline")

			// Each tick a minute later, past every claim's TTL. Five more ticks leave
			// room for a slow runner; an order that keeps deferring the same tail
			// never reaches every rule, however many ticks run.
			yield* Effect.forEach(
				[1, 2, 3, 4, 5],
				() =>
					Ref.update(shiftMs, (shift) => shift + 60_000).pipe(
						Effect.andThen(alerts.runSchedulerTick()),
					),
				{ discard: true },
			)

			assert.strictEqual(HashSet.size(yield* queried), RULE_COUNT)
		}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))
	})
})

describe("AlertsService claim fence", () => {
	const groupRow = (groupName: string, errorRate: number) =>
		tracesRow({ groupName, count: 200, errorRate, estimatedSpanCount: 200 })

	it.effect(
		"a tick whose claim expired mid-notification leaves the rule to the tick that re-claimed it",
		() => {
			const testDb = createTestDb(trackedDbs)
			const rows = Ref.makeUnsafe<ReadonlyArray<Record<string, unknown>>>([
				groupRow("checkout", 42),
				groupRow("payments", 42),
			])
			// Shifts the scheduler clock without moving TestClock, so timeouts already
			// armed inside the tick never fire.
			const shiftMs = Ref.makeUnsafe(0)
			// One-shot hooks: the next evaluation query and the next chart-series read
			// (the notification's enrichment) run these first.
			const onEvaluation = Ref.makeUnsafe<Effect.Effect<void>>(Effect.void)
			const onChartSeries = Ref.makeUnsafe<Effect.Effect<void>>(Effect.void)
			const runHook = (hook: Ref.Ref<Effect.Effect<void>>) =>
				Effect.flatten(Ref.getAndSet(hook, Effect.void))

			const base = makeWarehouseStub({})
			const evaluationRows = () => runHook(onEvaluation).pipe(Effect.andThen(Ref.get(rows)))
			const stub: WarehouseQueryServiceApi = {
				...base,
				compiledQuery: (_tenant, compiled, options) =>
					options?.context === "alertChartSeries"
						? runHook(onChartSeries).pipe(
								Effect.andThen(compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie)),
							)
						: evaluationRows().pipe(
								Effect.flatMap((r) =>
									compiledQueryOf(compiled).decodeRows(r).pipe(Effect.orDie),
								),
							),
				compiledQueryWithCapabilities: (_tenant, compile) =>
					evaluationRows().pipe(
						Effect.flatMap((r) =>
							Effect.runSync(compile(baselineWarehouseCapabilities()))
								.decodeRows(r)
								.pipe(Effect.orDie),
						),
					),
			}
			const overrides = {
				fetch: okFetch,
				now: Effect.zipWith(Clock.currentTimeMillis, Ref.get(shiftMs), (ms, shift) => ms + shift),
			}

			return Effect.gen(function* () {
				yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
				const alerts = yield* AlertsService
				const orgId = asOrgId("org_claim_fence")
				const userId = asUserId("user_claim_fence")
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				const rule = yield* alerts.createRule(
					orgId,
					userId,
					adminRoles,
					new AlertRuleUpsertRequest({
						name: "Grouped error rate",
						severity: "critical",
						enabled: true,
						groupBy: ["service.name"],
						signalType: "error_rate",
						comparator: "gt",
						threshold: 5,
						windowMinutes: 5,
						minimumSampleCount: 10,
						consecutiveBreachesRequired: 1,
						consecutiveHealthyRequired: 1,
						renotifyIntervalMinutes: 30,
						destinationIds: [destination.id],
					}),
				)

				yield* alerts.runSchedulerTick()
				assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 2)

				// Both groups recover. The first tick's warehouse result is late (20s), and
				// its first resolve notification is slow (another 20s): 40s after the
				// claim, past SCHEDULER_LOCK_TTL_MS. During that notification a second
				// tick re-claims the rule and resolves the group the first one has not
				// reached yet.
				yield* Ref.set(rows, [groupRow("checkout", 0.5), groupRow("payments", 0.5)])
				yield* TestClock.adjust(Duration.minutes(1))
				const firstClaimAt = DEFAULT_CLOCK_EPOCH_MS + 60_000
				const secondClaimAt = firstClaimAt + 40_000
				yield* Ref.set(
					onEvaluation,
					Ref.update(shiftMs, (shift) => shift + 20_000),
				)
				yield* Ref.set(
					onChartSeries,
					Ref.update(shiftMs, (shift) => shift + 20_000).pipe(
						Effect.andThen(alerts.runSchedulerTick()),
						Effect.asVoid,
						Effect.orDie,
					),
				)
				yield* alerts.runSchedulerTick()

				const incidents = (yield* alerts.listIncidents(orgId)).incidents
				assert.deepStrictEqual(
					incidents.map((incident) => incident.status),
					["resolved", "resolved"],
				)
				// Each group resolved once, by one tick each: the first tick stopped at
				// the group the second tick had already resolved.
				assert.sameMembers(
					incidents.map((incident) => incident.resolvedAt),
					[new Date(firstClaimAt).toISOString(), new Date(secondClaimAt).toISOString()],
				)
				const resolveEvents = (yield* alerts.listDeliveryEvents(orgId)).events.filter(
					(event) => event.eventType === "resolve",
				)
				assert.sameMembers(
					resolveEvents.map((event) => event.incidentId),
					incidents.map((incident) => incident.id),
				)

				const lateGroup = incidents.find(
					(incident) => incident.resolvedAt === new Date(secondClaimAt).toISOString(),
				)!.groupKey
				const lateState = yield* Effect.promise(() =>
					queryFirstRow<{ lastEvaluatedAt: Date | null; consecutiveHealthy: number }>(
						testDb,
						`select last_evaluated_at as "lastEvaluatedAt", consecutive_healthy as "consecutiveHealthy"
					   from alert_rule_states where rule_id = $1 and group_key = $2`,
						[rule.id, lateGroup],
					),
				)
				assert.strictEqual(lateState?.lastEvaluatedAt?.getTime(), secondClaimAt)
			}).pipe(Effect.provide(makeLayer(testDb, stub, overrides)))
		},
	)
})

describe("AlertsService fenced state flush", () => {
	// One healthy ungrouped rule: no transition, so its only write is the state flush.
	// `during` runs raw SQL on the database while the rule's evaluation is in flight.
	const flushWith = (during: string) => {
		const testDb = createTestDb(trackedDbs)
		const hook = Ref.makeUnsafe(false)
		const base = makeWarehouseStub({
			tracesAggregateRows: [tracesRow({ count: 200, errorRate: 1, estimatedSpanCount: 200 })],
		})
		const interfere = Effect.flatMap(Ref.getAndSet(hook, false), (armed) =>
			armed ? Effect.promise(() => testDb.pglite.exec(during)) : Effect.void,
		)
		const stub: WarehouseQueryServiceApi = {
			...base,
			compiledQueryWithCapabilities: (tenant, compile, options) =>
				Effect.andThen(interfere, base.compiledQueryWithCapabilities(tenant, compile, options)),
		}
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_fenced_flush")
			const userId = asUserId("user_fenced_flush")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			yield* Ref.set(hook, true)
			yield* alerts.runSchedulerTick()
			const states = yield* Effect.promise(() =>
				queryFirstRow<{ n: number }>(
					testDb,
					"select count(*)::int as n from alert_rule_states where rule_id = $1",
					[rule.id],
				),
			)
			return { stateRows: states?.n ?? 0 }
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	}

	it.effect("writes the state rows while the claim and the rule are unchanged", () =>
		Effect.map(flushWith("select 1"), ({ stateRows }) => assert.strictEqual(stateRows, 1)),
	)

	it.effect("writes nothing once a later tick has re-claimed the rule", () =>
		Effect.map(
			flushWith(
				"update alert_rule_claims set last_scheduled_at = last_scheduled_at + interval '30 seconds'",
			),
			({ stateRows }) => assert.strictEqual(stateRows, 0),
		),
	)

	it.effect("writes nothing once the rule was edited after the tick loaded it", () =>
		Effect.map(
			flushWith("update alert_rules set updated_at = updated_at + interval '1 second'"),
			({ stateRows }) => assert.strictEqual(stateRows, 0),
		),
	)
})

describe("AlertsService post-evaluation writes", () => {
	const GROUPS = 30
	const EXECUTE_DELAY_MS = 100

	// Every `Database.execute` waits first, like a Hyperdrive round trip at peak.
	const slowDb = (testDb: TestDb): TestDb => ({
		...testDb,
		layer: Layer.effect(
			Database,
			Effect.gen(function* () {
				const inner = yield* Database
				return Database.of({
					execute: (fn) =>
						Effect.sleep(Duration.millis(EXECUTE_DELAY_MS)).pipe(
							Effect.andThen(inner.execute(fn)),
						),
				})
			}),
		).pipe(Layer.provide(testDb.layer)),
	})

	it.live("writes a grouped rule's state rows in one batch, not one transaction per group", () => {
		const testDb = createTestDb(trackedDbs)
		const services = Arr.makeBy(GROUPS, (index) => `svc-${String(index).padStart(2, "0")}`)
		const stub = makeWarehouseStub({
			tracesAggregateRows: services.map((groupName) =>
				tracesRow({ groupName, count: 200, errorRate: 0.5, estimatedSpanCount: 200 }),
			),
		})
		const { spans, tracer } = makeRecordingTracer()

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_batch")
			const userId = asUserId("user_state_batch")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Grouped error rate",
					severity: "warning",
					enabled: true,
					groupBy: ["service.name"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					destinationIds: [destination.id],
				}),
			)

			const startedAt = yield* Clock.currentTimeMillis
			const tick = yield* alerts.runSchedulerTick().pipe(Effect.withTracer(tracer))
			const wallMs = (yield* Clock.currentTimeMillis) - startedAt

			assert.strictEqual(tick.evaluatedCount, 1)
			// One transaction per group would spend GROUPS * EXECUTE_DELAY_MS on writes alone.
			assert.isBelow(wallMs, GROUPS * EXECUTE_DELAY_MS)
			const flushes = spansNamed(spans, "AlertsService.flushRuleStates")
			assert.deepStrictEqual(
				flushes.map((span) => span.attributes.get("maple.alerting.state_rows")),
				[GROUPS],
			)

			const stored = yield* Effect.promise(() =>
				queryFirstRow<{ groups: number; healthy: number }>(
					testDb,
					`select count(*)::int as "groups",
					        count(*) filter (where last_status = 'healthy' and consecutive_healthy = 1)::int as "healthy"
					   from alert_rule_states where rule_id = $1`,
					[rule.id],
				),
			)
			assert.deepStrictEqual(stored, { groups: GROUPS, healthy: GROUPS })
		}).pipe(Effect.provide(makeLayer(slowDb(testDb), stub, { fetch: okFetch })))
	})

	it.live("retries a state flush that failed on a transient error", () => {
		const testDb = createTestDb(trackedDbs)
		const services = ["svc-a", "svc-b", "svc-c"]
		const stub = makeWarehouseStub({
			tracesAggregateRows: services.map((groupName) =>
				tracesRow({ groupName, count: 200, errorRate: 0.5, estimatedSpanCount: 200 }),
			),
		})
		const flushFailures = Ref.makeUnsafe(1)
		// The flush's first transaction fails like a dropped connection, which
		// the contention retry inside dbExecute does not cover.
		const flakyFlushDb: TestDb = {
			...testDb,
			layer: Layer.effect(
				Database,
				Effect.gen(function* () {
					const inner = yield* Database
					return Database.of({
						execute: (fn) =>
							Effect.gen(function* () {
								const span = yield* Effect.currentSpan.pipe(Effect.orElseSucceed(() => null))
								const fail =
									span?.name === "AlertsService.flushRuleStates" &&
									(yield* Ref.modify(flushFailures, (left) => [
										left > 0,
										Math.max(0, left - 1),
									]))
								if (fail) {
									return yield* new DatabaseError({
										message: "Connection terminated unexpectedly",
										cause: null,
									})
								}
								return yield* inner.execute(fn)
							}),
					})
				}),
			).pipe(Layer.provide(testDb.layer)),
		}

		return Effect.gen(function* () {
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_batch_retry")
			const userId = asUserId("user_state_batch_retry")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Grouped error rate",
					severity: "warning",
					enabled: true,
					groupBy: ["service.name"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					destinationIds: [destination.id],
				}),
			)

			yield* alerts.runSchedulerTick()

			assert.strictEqual(yield* Ref.get(flushFailures), 0, "the flush failed once")
			const stored = yield* Effect.promise(() =>
				queryFirstRow<{ healthy: number }>(
					testDb,
					`select count(*) filter (where last_status = 'healthy')::int as "healthy"
					   from alert_rule_states where rule_id = $1`,
					[rule.id],
				),
			)
			assert.deepStrictEqual(stored, { healthy: services.length })
		}).pipe(Effect.provide(makeLayer(flakyFlushDb, stub, { fetch: okFetch })))
	})

	it.effect("a rule edited before its flush keeps neither the buffered states nor their checks", () => {
		const testDb = createTestDb(trackedDbs)
		const services = ["svc-a", "svc-b", "svc-c"]
		const base = makeWarehouseStub({
			tracesAggregateRows: services.map((groupName) =>
				tracesRow({ groupName, count: 200, errorRate: 0.5, estimatedSpanCount: 200 }),
			),
		})
		const ingested: Array<Record<string, unknown>> = []
		// The rule to disable on the next warehouse query: set once the rule
		// exists, cleared by the edit so it runs once.
		const pendingEdit = Ref.makeUnsafe<string | null>(null)
		// An admin disables the rule while its evaluation is in flight, after the
		// tick loaded the rule and before the groups' state rows are flushed.
		const disableRule = Ref.getAndSet(pendingEdit, null).pipe(
			Effect.flatMap((ruleId) =>
				ruleId === null
					? Effect.void
					: Effect.promise(() =>
							queryFirstRow(
								testDb,
								`update alert_rules set enabled = false, updated_at = updated_at + interval '1 second'
								  where id = $1 returning id`,
								[ruleId],
							),
						),
			),
		)
		const stub: WarehouseQueryServiceApi = {
			...base,
			compiledQuery: (tenant, compiled) =>
				disableRule.pipe(Effect.andThen(base.compiledQuery(tenant, compiled))),
			compiledQueryWithCapabilities: (tenant, compile) =>
				disableRule.pipe(Effect.andThen(base.compiledQueryWithCapabilities(tenant, compile))),
			ingest: (_tenant, _datasource, rows) =>
				Effect.sync(() => {
					ingested.push(...(rows as Array<Record<string, unknown>>))
				}),
		}

		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_state_batch_edit")
			const userId = asUserId("user_state_batch_edit")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Grouped error rate",
					severity: "warning",
					enabled: true,
					groupBy: ["service.name"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					destinationIds: [destination.id],
				}),
			)
			yield* Ref.set(pendingEdit, rule.id)

			yield* alerts.runSchedulerTick()

			assert.isNull(yield* Ref.get(pendingEdit), "the edit ran during the tick")
			const stored = yield* Effect.promise(() =>
				queryFirstRow<{ healthy: number }>(
					testDb,
					`select count(*) filter (where last_status = 'healthy')::int as "healthy"
					   from alert_rule_states where rule_id = $1`,
					[rule.id],
				),
			)
			assert.deepStrictEqual(stored, { healthy: 0 })
			assert.deepStrictEqual(
				ingested.filter((row) => row.RuleId === rule.id && row.Status === "healthy"),
				[],
			)
		}).pipe(Effect.provide(makeLayer(testDb, stub, { fetch: okFetch })))
	})
})

describe("AlertsService investigation starts", () => {
	// One grouped rule whose `groupCount` groups all breach on the first tick, with
	// triage enabled, and a chat port that records each investigation turn it starts.
	const setupTriageStorm = (
		testDb: TestDb,
		groupCount: number,
		adapt: {
			readonly stub?: (stub: WarehouseQueryServiceApi) => WarehouseQueryServiceApi
			readonly now?: Effect.Effect<number>
		} = {},
	) => {
		const groups = Arr.makeBy(groupCount, (i) => `svc-${i}`)
		const alertRows: ReadonlyArray<Record<string, unknown>> = groups.map((groupName) =>
			tracesRow({ groupName, count: 200, errorRate: 10, satisfiedCount: 180, estimatedSpanCount: 200 }),
		)
		const baseStub = makeWarehouseStub({ tracesAggregateRows: alertRows })
		const stub = adapt.stub ? adapt.stub(baseStub) : baseStub
		const turns: Array<string> = []
		const chatSessions = fakeChatSessions(() => ({
			beginTurn: async (input: { sessionId: string; messageId: string }) => {
				turns.push(input.sessionId)
				return { cursor: 0, messageId: input.messageId, turnMessageId: input.messageId }
			},
		}))
		const createRule = Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			const alerts = yield* AlertsService
			const orgId = asOrgId("org_triage_storm")
			const userId = asUserId("user_triage_storm")
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* alerts.createRule(
				orgId,
				userId,
				adminRoles,
				new AlertRuleUpsertRequest({
					name: "Every service error rate",
					severity: "critical",
					enabled: true,
					groupBy: ["service.name"],
					signalType: "error_rate",
					comparator: "gt",
					threshold: 5,
					windowMinutes: 5,
					minimumSampleCount: 10,
					consecutiveBreachesRequired: 1,
					consecutiveHealthyRequired: 2,
					renotifyIntervalMinutes: 30,
					destinationIds: [destination.id],
				}),
			)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"insert into ai_triage_settings (org_id, enabled, max_runs_per_day, updated_at) values ($1, true, 100, now())",
					[orgId],
				),
			)
			return { alerts, orgId, rule }
		})
		const committedStates = (ruleId: string) =>
			Effect.promise(() =>
				queryFirstRow<{ n: number }>(
					testDb,
					"select count(*)::int as n from alert_rule_states where rule_id = $1",
					[ruleId],
				),
			).pipe(Effect.map((row) => row?.n ?? 0))
		const layer = makeLayer(testDb, stub, {
			fetch: okFetch,
			chatSessions,
			now: adapt.now ?? Clock.currentTimeMillis,
		})
		return { groups, turns, createRule, committedStates, layer }
	}

	it.effect("starts a grouped rule's investigations after its state is written, several at once", () => {
		const testDb = createTestDb(trackedDbs)
		const { groups, turns, createRule, committedStates, layer } = setupTriageStorm(testDb, 12)

		return Effect.gen(function* () {
			const { alerts, orgId, rule } = yield* createRule
			// What the classifier sees when it is called: how many of the rule's groups have a
			// committed state row, and how many classifications are in flight with it.
			const inFlight = yield* Ref.make(0)
			const peakInFlight = yield* Ref.make(0)
			const statesAtFirstCall = yield* Ref.make<number | null>(null)
			const classifier = Layer.succeed(IncidentClassifier, {
				classify: () =>
					Effect.gen(function* () {
						const states = yield* committedStates(rule.id)
						yield* Ref.update(statesAtFirstCall, (seen) => seen ?? states)
						const current = yield* Ref.updateAndGet(inFlight, (n) => n + 1)
						yield* Ref.update(peakInFlight, (peak) => Math.max(peak, current))
						yield* Effect.yieldNow.pipe(Effect.repeat({ times: 5 }))
						yield* Ref.update(inFlight, (n) => n - 1)
						return null
					}),
			})

			yield* alerts.runSchedulerTick().pipe(Effect.provide(classifier))

			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, groups.length)
			assert.lengthOf(turns, groups.length)
			assert.strictEqual(yield* Ref.get(statesAtFirstCall), groups.length)
			assert.isAbove(yield* Ref.get(peakInFlight), 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("starts every queued investigation when the triage phase runs past the claim TTL", () => {
		const testDb = createTestDb(trackedDbs)
		// The production storm: one rule opening 34 incidents.
		const { groups, turns, createRule, committedStates, layer } = setupTriageStorm(testDb, 34)

		return Effect.gen(function* () {
			const { alerts, rule } = yield* createRule
			const firstCall = yield* Ref.make<{ elapsedMs: number; states: number } | null>(null)
			// Every classification takes the classifier's full 10 s timeout, so the phase
			// runs far past tick start + 30 s.
			const classifier = Layer.succeed(IncidentClassifier, {
				classify: () =>
					Effect.gen(function* () {
						const elapsedMs = (yield* Clock.currentTimeMillis) - DEFAULT_CLOCK_EPOCH_MS
						const states = yield* committedStates(rule.id)
						yield* Ref.update(firstCall, (seen) => seen ?? { elapsedMs, states })
						yield* TestClock.adjust("10 seconds")
						return null
					}),
			})

			yield* alerts.runSchedulerTick().pipe(Effect.provide(classifier))

			const seen = yield* Ref.get(firstCall)
			assert.isNotNull(seen)
			assert.strictEqual(seen?.states, groups.length)
			assert.isBelow(seen?.elapsedMs ?? Infinity, 1_000)
			assert.isAbove((yield* Clock.currentTimeMillis) - DEFAULT_CLOCK_EPOCH_MS, 30_000)
			assert.lengthOf(turns, groups.length)
		}).pipe(Effect.provide(layer))
	})

	it.effect("releases the tick's unstarted claims before triage begins", () => {
		const testDb = createTestDb(trackedDbs)
		// Every warehouse answer moves the scheduler's clock a minute on, so once the first
		// evaluations return, the rules still waiting for a lane pass the tick deadline.
		const shiftMs = Ref.makeUnsafe(0)
		const advance = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.tap(effect, () => Ref.update(shiftMs, (shift) => shift + 60_000))
		const { turns, createRule, layer } = setupTriageStorm(testDb, 3, {
			now: Effect.zipWith(Clock.currentTimeMillis, Ref.get(shiftMs), (ms, shift) => ms + shift),
			stub: (base) => ({
				...base,
				compiledQuery: (...args) => advance(base.compiledQuery(...args)),
				compiledQueryWithCapabilities: (...args) =>
					advance(base.compiledQueryWithCapabilities(...args)),
				compiledQueryFirst: (...args) => advance(base.compiledQueryFirst(...args)),
			}),
		})
		const { spans, tracer } = makeRecordingTracer()

		return Effect.gen(function* () {
			const { alerts } = yield* createRule
			// Created after the storm rule, so the scheduler reaches them later: more rules
			// than lanes, in an org without triage.
			const otherOrg = asOrgId("org_triage_other")
			const destination = yield* createWebhookDestination(alerts, otherOrg, asUserId("user_other"))
			yield* Effect.forEach(
				Arr.range(1, 6),
				(index) =>
					TestClock.adjust("2 millis").pipe(
						Effect.andThen(
							alerts.createRule(
								otherOrg,
								asUserId("user_other"),
								adminRoles,
								new AlertRuleUpsertRequest({
									name: `Other rule ${index}`,
									severity: "warning",
									enabled: true,
									signalType: "error_rate",
									comparator: "gt",
									threshold: 99,
									windowMinutes: 5,
									destinationIds: [destination.id],
								}),
							),
						),
					),
				{ discard: true },
			)
			// Whether the release had finished each time the triage phase opened.
			const releasedAtTriageStart: Array<boolean> = []
			const classifier = Layer.succeed(IncidentClassifier, { classify: () => Effect.succeed(null) })
			const recording = Tracer.make({
				span(options) {
					if (options.name === "AlertsService.startPendingTriages") {
						releasedAtTriageStart.push(
							spansNamed(spans, "AlertsService.releaseClaims").some(
								(span) => span.status._tag === "Ended",
							),
						)
					}
					return tracer.span(options)
				},
			})

			const tick = yield* alerts
				.runSchedulerTick()
				.pipe(Effect.provide(classifier), Effect.withTracer(recording))

			assert.isAbove(tick.deferredCount, 0)
			assert.deepStrictEqual(releasedAtTriageStart, [true])
			assert.lengthOf(turns, 3)
		}).pipe(Effect.provide(layer))
	})
})
