// Shared fixtures for the AlertsService suites, split across files so CI can shard them.
// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { LiveActivitiesService } from "@maple/backend/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@maple/backend/services/push/MobileDevicesService"
import { ApnsClient } from "@maple/backend/platform/Apns"
import { MobilePushService } from "@maple/backend/services/push/MobilePushService"
import { ChatAlertPoster } from "./ChatAlertPoster"
import { Cause, Clock, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import {
	AlertRecipientSelectionError,
	type AlertDestinationId,
	AlertRuleUpsertRequest,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import type { WarehouseQueryServiceApi } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { AlertRuntime, type AlertRuntimeApi, AlertsService, type AlertsServiceApi } from "./AlertsService"
import { AlertDestinationsService } from "./AlertDestinationsService"
import { AlertReadModelsService } from "./AlertReadModelsService"
import { AlertRulesService } from "./AlertRulesService"
import { UptimeAlertSource } from "@maple/backend/services/uptime/UptimeAlertSource"
import { BucketCacheService } from "@maple/query-engine/caching"
import { EdgeCacheService } from "@maple/cache"
import { baselineWarehouseCapabilities } from "@maple/query-engine"
import { CacheBackendLive } from "@maple/backend/platform/CacheBackendLive"
import { Env } from "@maple/backend/platform/Env"
import { HazelOAuthService } from "@maple/backend/services/auth/HazelOAuthService"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import { LinearIssueTracker } from "./LinearIssueTracker"
import { EmailService } from "@maple/backend/platform/EmailService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { OrgMembersService, type OrgMember } from "@maple/backend/services/org/OrgMembersService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"
import {
	type CapabilityCompile,
	type CompiledQueryInput,
	compiledQueryOf,
} from "@maple/query-engine/execution"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { ChatSessions, type ChatSessionsApi } from "@maple/backend/platform/bindings"

export const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
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
			LINEAR_OAUTH_CLIENT_ID: "lin-client-id",
			LINEAR_OAUTH_CLIENT_SECRET: "lin-client-secret",
		}),
	)

export const emptyWarehouseRows: ReadonlyArray<Record<string, unknown>> = []

/**
 * A complete `traces.timeseries` row.
 *
 * The queries derive their row schema from the SELECT now, so `decodeRows`
 * rejects a partial fixture instead of handing it through — which is the point:
 * every one of these fixtures was missing `bucket`, `groupName`, `spanCount`
 * and `estimatedSpanCount`, and none of them would have noticed the warehouse
 * dropping one.
 */
export const tracesRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
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

export function makeWarehouseStub(state: {
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

	// Both compiled-query forms decode the stubbed rows; the capability-aware form
	// compiles against baseline capabilities, as the real executor does without a probe.
	const resolve = <T>(compiled: CompiledQueryInput<T> | CapabilityCompile<T>) =>
		typeof compiled === "function"
			? Effect.runSync(Effect.orDie(compiled(baselineWarehouseCapabilities())))
			: compiledQueryOf(compiled)

	// `compiledQuery` is overloaded, so it takes the executor's own shape: one generic
	// implementation over both inputs, typed as the overload set.
	const compiledQuery = (<T>(_tenant: unknown, compiled: CompiledQueryInput<T> | CapabilityCompile<T>) =>
		sqlQueryStub().pipe(
			Effect.flatMap((rows) => resolve(compiled).decodeRows(rows).pipe(Effect.orDie)),
		)) as WarehouseQueryServiceApi["compiledQuery"]

	return makeWarehouseServiceStub({
		rawSqlQuery: sqlQueryStub,
		compiledQuery,
		compiledQueryWithCapabilities: (_tenant, compile) =>
			sqlQueryStub().pipe(
				Effect.flatMap((rows) => resolve(compile).decodeRows(rows).pipe(Effect.orDie)),
			),
		compiledQueryFirst: (_tenant, compiled) =>
			sqlQueryStub().pipe(
				Effect.flatMap((rows) => resolve(compiled).decodeFirstRow(rows).pipe(Effect.orDie)),
			),
		ingest: () => Effect.void,
	})
}

export const defaultTestRuntime: AlertRuntimeApi = {
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

export interface TestOverrides extends Partial<AlertRuntimeApi> {
	/** Provided as `FetchHttpClient.Fetch`, so every outbound call goes through it. */
	readonly fetch?: typeof fetch
	/** The investigation agent's port; absent means investigations cannot start. */
	readonly chatSessions?: ChatSessionsApi
}

// The fixed epoch scheduler tests start TestClock at, mirroring the previous
// manual clock's default start time.
export const DEFAULT_CLOCK_EPOCH_MS = 1_700_000_000_000

export const stubEmailService = (
	sent?: Array<{ to: string; subject: string; html: string }>,
): (typeof EmailService)["Service"] => ({
	isConfigured: true,
	send: (to, subject, html) =>
		Effect.sync(() => {
			sent?.push({ to, subject, html })
		}),
})

/** Fixed workspace-member directory the OrgMembersService stub resolves against. */
export const TEST_ORG_MEMBERS: ReadonlyArray<OrgMember> = [
	{ userId: "user_ops", email: "ops@acme.test", name: "Ops Team", imageUrl: null },
	{ userId: "user_oncall", email: "oncall@acme.test", name: null, imageUrl: null },
	{ userId: "user_lead", email: "lead@acme.test", name: "Lead", imageUrl: null },
]

export const stubOrgMembersService = (
	members: ReadonlyArray<OrgMember> = TEST_ORG_MEMBERS,
): (typeof OrgMembersService)["Service"] => ({
	listMembers: () => Effect.succeed(members),
	listOrganizationsOf: () => Effect.succeed([]),
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

export const makeLayer = (
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
	const linearOAuthLive = LinearOAuthService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, databaseLive)),
	)
	const linearIssuesLive = Layer.effect(LinearIssueTracker, LinearIssueTracker.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.mergeAll(linearOAuthLive, databaseLive)),
	)
	const emailLive = Layer.succeed(EmailService, emailStub ?? stubEmailService())
	const orgMembersLive = Layer.succeed(OrgMembersService, stubOrgMembersService())
	const orgChSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(envLive, databaseLive, edgeCacheLive)),
	)
	const alertDestinationsLive = Layer.effect(AlertDestinationsService, AlertDestinationsService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(chatAlertPoster),
		Layer.provide(
			Layer.mergeAll(
				envLive,
				databaseLive,
				runtimeLive,
				hazelOAuthLive,
				linearOAuthLive,
				linearIssuesLive,
				emailLive,
				orgMembersLive,
			),
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
		Layer.provide(linearIssuesLive),
		Layer.provide(emailLive),
		Layer.provide(orgMembersLive),
		Layer.provide(orgChSettingsLive),
		Layer.provide(investigationsLive),
		Layer.provide(alertDestinationsLive),
		Layer.provide(alertReadModelsLive),
		Layer.provide(alertRulesLive),
		Layer.provide(UptimeAlertSource.layer.pipe(Layer.provide(databaseLive))),
		Layer.provide(chatSessions === undefined ? Layer.empty : Layer.succeed(ChatSessions, chatSessions)),
	)
	return Layer.mergeAll(alertDestinationsLive, alertReadModelsLive, alertRulesLive, alertsLive).pipe(
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetchImpl)),
	)
}

export const asOrgId = Schema.decodeUnknownSync(OrgId)
export const asUserId = Schema.decodeUnknownSync(UserId)
export const asRoleName = Schema.decodeUnknownSync(RoleName)

export const adminRoles = [asRoleName("root")]
export const memberRoles = [asRoleName("org:member")]

export const createWebhookDestination = (
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

export const createErrorRateRule = (
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

export const makeUuidSequence = (...values: string[]): Pick<AlertRuntimeApi, "makeUuid"> => {
	let index = 0
	return {
		makeUuid: () => values[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
	}
}

export const okFetch: typeof fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch

export const insertDeliveryEventRow = async (
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
