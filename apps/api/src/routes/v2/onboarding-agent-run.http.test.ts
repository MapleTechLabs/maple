import { afterEach, describe, expect, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { MapleApiV2, V2OnboardingAgentHandoff, V2OnboardingAgentRun } from "@maple/domain/http/v2"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { Env } from "@maple/backend/platform/Env"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { CliDeviceAuthService } from "@maple/backend/services/auth/CliDeviceAuthService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { OnboardingAgentRunService } from "@maple/backend/services/onboarding/OnboardingAgentRunService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import { HttpV2OnboardingAgentRunLive } from "./onboarding-agent-run.http"
import { ApiV2RateLimiterAllowAllLayer, makeWarehouseServiceStub } from "./v2-test-support"

/**
 * `/v2/onboarding/agent_run` end to end: a signed-in person mints the handoff, the code signs a
 * CLI in through the device-login poll, and that CLI credential reports to the person's run.
 */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

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
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		CliDeviceAuthService.layer,
		OnboardingAgentRunService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(
		HttpApi.make("MapleApiV2").add(MapleApiV2.groups.onboardingAgentRun),
	).pipe(
		Layer.provide(HttpV2OnboardingAgentRunLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(Layer.succeed(WarehouseQueryService, makeWarehouseServiceStub({}))),
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	const request = async (method: "GET" | "POST", path: string, token: string, body?: unknown) => {
		const headers = new Headers({ authorization: `Bearer ${token}` })
		const init: RequestInit = { method, headers }
		if (body !== undefined) {
			headers.set("content-type", "application/json")
			init.body = JSON.stringify(body)
		}
		const response = await handler(
			new Request(`http://maple.test${path}`, init),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null }
	}

	const session = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const auth = yield* AuthService
				return (yield* auth.loginSelfHosted("test-root-password")).token
			}),
		)

	/** What `MAPLE_HANDOFF=<code> maple auth login` does: poll the device login with the code. */
	const signInCli = (code: string) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const cliAuth = yield* CliDeviceAuthService
				const polled = yield* cliAuth.poll(code)
				if (polled.status !== "complete")
					return yield* Effect.die(`handoff poll was ${polled.status}`)
				return polled
			}),
		)

	return {
		request,
		session,
		signInCli,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

describe("/v2/onboarding/agent_run", () => {
	it("hands a run to a CLI that reports stages the person then reads", async () => {
		const harness = makeHarness()
		try {
			const token = await harness.session()
			const started = await harness.request("POST", "/v2/onboarding/agent_run", token)
			expect(started.status).toBe(200)
			const handoff = Schema.decodeUnknownSync(V2OnboardingAgentHandoff)(started.body)
			expect(handoff.run.status).toBe("waiting_for_agent")

			const cli = await harness.signInCli(handoff.handoff_code)
			const reported = await harness.request("POST", "/v2/onboarding/agent_run/status", cli.token, {
				stage: "send_verification",
				status: "completed",
				service_names: ["checkout-api"],
			})
			expect(reported.status).toBe(200)

			const read = await harness.request("GET", "/v2/onboarding/agent_run", token)
			const run = Schema.decodeUnknownSync(V2OnboardingAgentRun)(read.body)
			expect(run.status).toBe("in_progress")
			expect(run.service_names).toEqual(["checkout-api"])
			expect(
				Option.map(
					Arr.findFirst(run.stages, (stage) => stage.id === "send_verification"),
					(stage) => stage.status,
				),
			).toEqual(Option.some("completed"))
		} finally {
			await harness.dispose()
		}
	})

	it("refuses to mint a handoff for an API key", async () => {
		const harness = makeHarness()
		try {
			const started = await harness.request("POST", "/v2/onboarding/agent_run", await harness.session())
			const cli = await harness.signInCli(
				Schema.decodeUnknownSync(V2OnboardingAgentHandoff)(started.body).handoff_code,
			)
			const refused = await harness.request("POST", "/v2/onboarding/agent_run", cli.token)
			expect(refused.status).toBe(403)
		} finally {
			await harness.dispose()
		}
	})

	it("rejects a report with an unknown stage as a 400", async () => {
		const harness = makeHarness()
		try {
			const token = await harness.session()
			await harness.request("POST", "/v2/onboarding/agent_run", token)
			const bad = await harness.request("POST", "/v2/onboarding/agent_run/status", token, {
				stage: "deploy_everything",
				status: "completed",
			})
			expect(bad.status).toBe(400)
		} finally {
			await harness.dispose()
		}
	})

	it("answers 409 once the run is closed so the agent stops", async () => {
		const harness = makeHarness()
		try {
			const token = await harness.session()
			await harness.request("POST", "/v2/onboarding/agent_run", token)
			await harness.request("POST", "/v2/onboarding/agent_run/status", token, {
				stage: "prepare_production",
				status: "completed",
				run_status: "completed",
			})
			const after = await harness.request("POST", "/v2/onboarding/agent_run/status", token, {
				stage: "prepare_production",
				status: "active",
			})
			expect(after.status).toBe(409)
			expect(after.body.error.code).toBe("onboarding_agent_run_closed")
		} finally {
			await harness.dispose()
		}
	})
})
