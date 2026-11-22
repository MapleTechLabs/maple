import { afterEach, describe, expect, it } from "@effect/vitest"
import { Array as Arr, Context, Effect, Layer, Result, Schema } from "effect"
import { OrgId, RoleName, UserId, type TenantContext } from "@maple/domain/http"
import { GetIngestSetupOutput, OnboardingStatusUpdateOutput } from "@maple/domain/mcp-outputs"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { IngestSetupService } from "@maple/backend/services/onboarding/IngestSetupService"
import { OnboardingAgentRunService } from "@maple/backend/services/onboarding/OnboardingAgentRunService"
import { testEnv } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { CurrentMcpTenant } from "../../tenant"
import { executeRegisteredMcpToolUnscoped } from "../registry"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const orgId = Schema.decodeSync(OrgId)("org_onboarding_tools")
const userId = Schema.decodeSync(UserId)("user_onboarding_tools")
const owner = { orgId, userId }

const tenant = (readOnly: boolean): TenantContext => ({
	orgId,
	userId,
	roles: [Schema.decodeSync(RoleName)("root")],
	authMode: "self_hosted",
	...(readOnly ? { readOnly: true as const } : undefined),
})

const layer = (options: { readonly readOnly?: boolean } = {}) => {
	const db = createTestDb(createdDbs).layer
	const env = testEnv({
		MAPLE_INGEST_PUBLIC_URL: "https://ingest.eu.maple.test/",
		MAPLE_APP_BASE_URL: "https://app.eu.maple.test",
	})
	return Layer.mergeAll(
		OnboardingAgentRunService.layer,
		IngestSetupService.layer,
		Layer.succeed(CurrentMcpTenant, tenant(options.readOnly ?? false)),
	).pipe(Layer.provide(Layer.mergeAll(db, env)))
}

// The registry's requirements name every tool's services; these tools reach only the ones above.
const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

const call = (name: string, params: unknown) =>
	executeRegisteredMcpToolUnscoped(name, params, "mcp").pipe(Effect.result, withoutUnreachedServices)

const reportStatus = (params: unknown) =>
	Effect.gen(function* () {
		const result = yield* call("onboarding_status_update", params)
		if (Result.isFailure(result)) return yield* Effect.die(result.failure)
		return {
			text: Arr.join(
				Arr.map(result.success.content, (part) => part.text),
				"\n",
			),
			output: Schema.decodeUnknownSync(OnboardingStatusUpdateOutput)(result.success.structuredContent),
		}
	})

describe("onboarding_status_update", () => {
	it.effect("records a stage on the caller's run", () =>
		Effect.gen(function* () {
			yield* (yield* OnboardingAgentRunService).start(owner)
			const { output, text } = yield* reportStatus({
				stage: "receive_verification",
				status: "completed",
				note: "First trace arrived",
				services: ["api", "web"],
				trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
			})
			expect(output.outcome).toBe("reported")
			expect(output.run?.serviceNames).toEqual(["api", "web"])
			expect(output.run?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
			const stage = Arr.findFirst(output.run?.stages ?? [], (s) => s.stage === "receive_verification")
			expect(stage._tag === "Some" ? stage.value.status : undefined).toBe("completed")
			expect(text).toContain("receive_verification: completed (First trace arrived)")
		}).pipe(Effect.provide(layer())),
	)

	it.effect("tells the agent to stop reporting once the run is closed", () =>
		Effect.gen(function* () {
			yield* (yield* OnboardingAgentRunService).start(owner)
			yield* reportStatus({ stage: "prepare_production", status: "completed", run_status: "completed" })
			const { output, text } = yield* reportStatus({ stage: "connect_agent", status: "active" })
			expect(output.outcome).toBe("closed")
			expect(text).toContain("Stop sending status updates")
		}).pipe(Effect.provide(layer())),
	)

	it.effect("answers without failing when the user has no run", () =>
		Effect.gen(function* () {
			const { output, text } = yield* reportStatus({ stage: "connect_agent", status: "active" })
			expect(output).toMatchObject({ outcome: "no_run", run: null })
			expect(text).toContain("nothing to report")
		}).pipe(Effect.provide(layer())),
	)

	it.effect("refuses a trace id that is not 32 lowercase hex characters", () =>
		Effect.gen(function* () {
			yield* (yield* OnboardingAgentRunService).start(owner)
			const result = yield* call("onboarding_status_update", {
				stage: "send_verification",
				status: "completed",
				trace_id: "4BF92F3577B34DA6",
			})
			expect(Result.isFailure(result)).toBe(true)
			if (Result.isFailure(result)) {
				expect(result.failure).toMatchObject({
					_tag: "@maple/mcp/errors/McpInvalidInputError",
					parameter: "trace_id",
				})
			}
		}).pipe(Effect.provide(layer())),
	)

	it.effect("is refused to a read-only key", () =>
		Effect.gen(function* () {
			const result = yield* call("onboarding_status_update", {
				stage: "connect_agent",
				status: "active",
			})
			expect(Result.isFailure(result)).toBe(true)
			if (Result.isFailure(result)) {
				expect(result.failure).toMatchObject({
					_tag: "@maple/mcp/errors/McpAuthInvalidError",
					reason: "insufficient_scope",
				})
			}
		}).pipe(Effect.provide(layer({ readOnly: true }))),
	)
})

describe("get_ingest_setup", () => {
	it.effect("returns the region's endpoint and the public key, never the private one", () =>
		Effect.gen(function* () {
			const result = yield* call("get_ingest_setup", {})
			expect(Result.isSuccess(result)).toBe(true)
			if (Result.isSuccess(result)) {
				const output = Schema.decodeUnknownSync(GetIngestSetupOutput)(
					result.success.structuredContent,
				)
				expect(output.ingestEndpoint).toBe("https://ingest.eu.maple.test")
				expect(output.publicIngestKey).toMatch(/^maple_pk_/)
				expect(output.ingestSettingsUrl).toBe("https://app.eu.maple.test/settings/ingestion")
				expect(output.setupGuideUrl).toBe("https://maple.dev/SKILL.md")
				expect(JSON.stringify(result.success)).not.toContain("maple_sk_")
				expect(result.success.content[0]?.text).toContain("list_services")
			}
		}).pipe(Effect.provide(layer())),
	)

	it.effect("is refused to a read-only key, since it may create the org's ingest keys", () =>
		Effect.gen(function* () {
			const result = yield* call("get_ingest_setup", {})
			expect(Result.isFailure(result)).toBe(true)
			if (Result.isFailure(result)) {
				expect(result.failure).toMatchObject({
					_tag: "@maple/mcp/errors/McpAuthInvalidError",
					reason: "insufficient_scope",
				})
			}
		}).pipe(Effect.provide(layer({ readOnly: true }))),
	)
})
