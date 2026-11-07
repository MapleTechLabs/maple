import { afterEach, describe, expect, it } from "@effect/vitest"
import { Array as Arr, Context, Effect, Layer, Result, Schema } from "effect"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { ListMapleFeedbackOutput } from "@maple/domain/mcp-outputs"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { AgentFeedbackService } from "@maple/backend/services/feedback/AgentFeedbackService"
import { type AuditActorInfo, CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import { testEnv } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { CurrentMcpTenant } from "../../lib/query-warehouse"
import { executeRegisteredMcpToolUnscoped } from "../registry"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const INTERNAL = Schema.decodeSync(OrgId)("org_maple_internal")
const CUSTOMER = Schema.decodeSync(OrgId)("org_customer")
const USER = Schema.decodeSync(UserId)("user_feedback")

const tenant = (orgId: OrgId): TenantContext => ({
	orgId,
	userId: USER,
	roles: [Schema.decodeSync(RoleName)("root")],
	authMode: "self_hosted",
})

const OAUTH_USER: AuditActorInfo = { type: "user", source: "mcp" }

const layer = (
	orgId: OrgId,
	options: { readonly actor?: AuditActorInfo; readonly env?: Record<string, unknown> } = {},
) =>
	Layer.mergeAll(
		AgentFeedbackService.layer.pipe(
			Layer.provide(
				Layer.mergeAll(
					createTestDb(createdDbs).layer,
					testEnv(options.env ?? { MAPLE_INTERNAL_ORG_ID: INTERNAL }),
				),
			),
		),
		Layer.succeed(CurrentMcpTenant, tenant(orgId)),
		Layer.succeed(CurrentAuditActor, "actor" in options ? options.actor : OAUTH_USER),
	)

// The registry's requirements name every tool's services; this tool reaches only the ones above.
const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

const call = (params: unknown) =>
	executeRegisteredMcpToolUnscoped("list_maple_feedback", params, "mcp").pipe(
		Effect.result,
		withoutUnreachedServices,
	)

const expectRefused = (result: Result.Result<unknown, { readonly _tag: string }>) => {
	expect(Result.isFailure(result)).toBe(true)
	if (Result.isFailure(result)) {
		expect(result.failure).toMatchObject({
			_tag: "@maple/mcp/errors/McpAuthInvalidError",
			reason: "insufficient_scope",
		})
	}
}

const seed = Effect.gen(function* () {
	const service = yield* AgentFeedbackService
	yield* Effect.forEach([INTERNAL, CUSTOMER], (orgId) =>
		service.submit(orgId, USER, {
			kind: "bug",
			summary: `from ${orgId}`,
			reason: "Secret customer context",
			agent: { type: "coding_agent" },
			source: "mcp",
		}),
	)
})

describe("list_maple_feedback", () => {
	it.effect("gives Maple's internal org every org's feedback", () =>
		Effect.gen(function* () {
			yield* seed
			const result = yield* call({})
			expect(Result.isSuccess(result)).toBe(true)
			if (Result.isSuccess(result)) {
				const output = Schema.decodeUnknownSync(ListMapleFeedbackOutput)(
					result.success.structuredContent,
				)
				expect(Arr.map(output.reports, (report) => report.orgId).sort()).toEqual(
					[CUSTOMER, INTERNAL].sort(),
				)
				expect(result.success.content[0]?.text).toContain("Secret customer context")
			}
		}).pipe(Effect.provide(layer(INTERNAL))),
	)

	it.effect("refuses a customer org, even for its own feedback", () =>
		Effect.gen(function* () {
			yield* seed
			expectRefused(yield* call({ org_id: CUSTOMER }))
		}).pipe(Effect.provide(layer(CUSTOMER))),
	)

	it.effect("refuses Maple's own agents and the bot (internal service token) in the internal org", () =>
		Effect.gen(function* () {
			yield* seed
			expectRefused(yield* call({}))
		}).pipe(Effect.provide(layer(INTERNAL, { actor: { type: "system", source: "system" } }))),
	)

	it.effect("refuses an in-process call that carries no transport actor", () =>
		Effect.gen(function* () {
			yield* seed
			expectRefused(yield* call({}))
		}).pipe(Effect.provide(layer(INTERNAL, { actor: undefined }))),
	)

	it.effect("refuses every org while MAPLE_INTERNAL_ORG_ID is unset", () =>
		Effect.gen(function* () {
			yield* seed
			expectRefused(yield* call({}))
		}).pipe(Effect.provide(layer(INTERNAL, { env: {} }))),
	)
})
