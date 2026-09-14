import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2, V2OnboardingChecklist } from "@maple/domain/http/v2"
import {
	type OnboardingChecklistEvaluation,
	OnboardingRewardNotClaimableError,
} from "@maple/domain/onboarding-checklist"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { Env } from "@maple/backend/platform/Env"
import { ApiAuthorizationV2Layer } from "@maple/backend/services/auth/ApiAuthorizationV2Layer"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { IngestAttributeMappingService } from "@maple/backend/services/org/IngestAttributeMappingService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { OnboardingChecklistService } from "@maple/backend/services/org/OnboardingChecklistService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import { HttpV2OnboardingChecklistLive } from "./onboarding-checklist.http"
import {
	AlertsServiceStubLayer,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	makeWarehouseServiceStub,
	Phase1ResourceStubsLayer,
	PlanetScaleServiceStubsLayer,
	SlackIntegrationServiceStubLayer,
	TelemetryServiceStubsLayer,
	V2GroupLayersExceptOnboardingChecklist,
} from "./v2-test-support"

/**
 * Wire-contract tests for `/v2/onboarding/checklist`. The step rules live in
 * packages/domain and the fan-out in packages/backend; what matters here is the shape
 * a client sees, the admin gate on the claim, and that a refusal comes back as the
 * 409 envelope rather than a 500.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_checklist_e2e")
const USER = Schema.decodeUnknownSync(UserId)("user_checklist_e2e")

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3512",
			MCP_PORT: "3513",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const report = (status: OnboardingChecklistEvaluation["status"]): OnboardingChecklistEvaluation => ({
	status,
	deadlineAtMs: Date.parse("2026-07-28T12:00:00.000Z"),
	claimedAtMs: status === "claimed" ? Date.parse("2026-07-27T18:00:00.000Z") : null,
	steps: [
		{ id: "send_telemetry", completed: true },
		{ id: "connect_github", completed: true },
		{ id: "create_alert_rule", completed: status !== "in_progress" },
		{ id: "invite_teammate", completed: status !== "in_progress" },
		{ id: "connect_mcp_agent", completed: status !== "in_progress" },
	],
	completedCount: status === "in_progress" ? 2 : 5,
	totalCount: 5,
})

const makeHarness = (status: OnboardingChecklistEvaluation["status"]) => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const warehouseLive = Layer.succeed(WarehouseQueryService, makeWarehouseServiceStub({}))
	const claims: Array<string> = []

	const checklistStub = Layer.succeed(OnboardingChecklistService, {
		read: () => Effect.succeed(report(status)),
		claim: (tenant) =>
			Effect.suspend(() => {
				claims.push(tenant.userId)
				return status === "claimable" || status === "claimed"
					? Effect.succeed(report("claimed"))
					: Effect.fail(
							new OnboardingRewardNotClaimableError({
								message: "Finish every step of the checklist before claiming the reward.",
								reason: status === "expired" ? "expired" : "incomplete",
							}),
						)
			}),
	})

	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
		IngestAttributeMappingService.layer,
		OrgIngestKeysService.layer,
		ConfigResourceServiceStubsLayer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(
			Layer.mergeAll(
				V2GroupLayersExceptOnboardingChecklist,
				HttpV2OnboardingChecklistLive.pipe(Layer.provide(checklistStub)),
			),
		),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(Phase1ResourceStubsLayer),
		Layer.provide(SlackIntegrationServiceStubLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provide(warehouseLive),
		Layer.provideMerge(ApiAuthorizationV2Layer),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)

	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	const request = async (method: "GET" | "POST", path: string, token?: string) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null }
	}

	const bootstrapKey = (options: { readonly member?: boolean } = {}) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(ORG, USER, {
					name: "checklist-test",
					// Roles are pinned by metadata, the way the CLI login mints member credentials.
					...(options.member
						? {
								metadataJson: {
									source: "maple_cli",
									roles: ["org:member"],
									deviceName: "laptop",
								},
							}
						: undefined),
				})
			}),
		)

	return {
		request,
		bootstrapKey,
		claims,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("GET /v2/onboarding/checklist", () => {
	it("renders the checklist with every step's title and destination", async () => {
		const harness = makeHarness("in_progress")
		try {
			const key = await harness.bootstrapKey()
			const { status, body } = await harness.request("GET", "/v2/onboarding/checklist", key.secret)
			expect(status).toBe(200)
			const checklist = Schema.decodeUnknownSync(V2OnboardingChecklist)(body)
			expect(checklist.status).toBe("in_progress")
			expect(checklist.reward_amount_usd).toBe(30)
			expect(checklist.deadline_at).toBe("2026-07-28T12:00:00.000Z")
			expect(checklist.completed_count).toBe(2)
			expect(checklist.steps.map((step) => step.id)).toEqual([
				"send_telemetry",
				"connect_github",
				"create_alert_rule",
				"invite_teammate",
				"connect_mcp_agent",
			])
			expect(checklist.steps[1]).toEqual({
				object: "onboarding_checklist_step",
				id: "connect_github",
				title: "Connect GitHub",
				completed: true,
				href: "/integrations?integration=github",
			})
		} finally {
			await harness.dispose()
		}
	})

	it("requires authentication", async () => {
		const harness = makeHarness("in_progress")
		try {
			const { status } = await harness.request("GET", "/v2/onboarding/checklist")
			expect(status).toBe(401)
		} finally {
			await harness.dispose()
		}
	})
})

describe("POST /v2/onboarding/checklist/claim", () => {
	it("applies the credit for an admin and returns the claimed checklist", async () => {
		const harness = makeHarness("claimable")
		try {
			const key = await harness.bootstrapKey()
			const { status, body } = await harness.request(
				"POST",
				"/v2/onboarding/checklist/claim",
				key.secret,
			)
			expect(status, JSON.stringify(body)).toBe(200)
			expect(Schema.decodeUnknownSync(V2OnboardingChecklist)(body).status).toBe("claimed")
			expect(harness.claims).toEqual([USER])
		} finally {
			await harness.dispose()
		}
	})

	it("refuses a member before the service is even asked", async () => {
		const harness = makeHarness("claimable")
		try {
			const key = await harness.bootstrapKey({ member: true })
			const { status, body } = await harness.request(
				"POST",
				"/v2/onboarding/checklist/claim",
				key.secret,
			)
			expect(status, JSON.stringify(body)).toBe(403)
			expect(body.error.code).toBe("insufficient_permissions")
			expect(harness.claims).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	it("answers a premature claim with the 409 envelope", async () => {
		const harness = makeHarness("in_progress")
		try {
			const key = await harness.bootstrapKey()
			const { status, body } = await harness.request(
				"POST",
				"/v2/onboarding/checklist/claim",
				key.secret,
			)
			expect(status, JSON.stringify(body)).toBe(409)
			expect(body.error.code).toBe("onboarding_reward_not_claimable")
			expect(body.error._tag).toBe("@maple/http/errors/OnboardingRewardNotClaimableError")
			// The envelope carries the human sentence, which is what the panel shows.
			expect(body.error.message).toMatch(/Finish every step/)
		} finally {
			await harness.dispose()
		}
	})
})
