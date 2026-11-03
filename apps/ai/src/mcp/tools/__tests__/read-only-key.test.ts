import { afterEach, describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Result, Schema } from "effect"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { CurrentMcpTenant } from "../../lib/query-warehouse"
import { executeRegisteredMcpToolUnscoped } from "../registry"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const tenant = (readOnly: boolean): TenantContext => ({
	orgId: Schema.decodeSync(OrgId)("org_read_only_key"),
	userId: Schema.decodeSync(UserId)("user_read_only_key"),
	roles: [Schema.decodeSync(RoleName)("root")],
	authMode: "self_hosted",
	...(readOnly ? { readOnly: true as const } : undefined),
})

const makeLayer = (readOnly: boolean) => {
	const database = createTestDb(createdDbs).layer
	return Layer.mergeAll(
		ErrorPolicyService.layer.pipe(Layer.provide(database)),
		database,
		Layer.succeed(CurrentMcpTenant, tenant(readOnly)),
		Layer.succeed(AlertsService, {
			listDestinations: () => Effect.succeed({ destinations: [] }),
		} as never),
	)
}

// The registry's requirements name every tool's services; these tools reach only the ones above.
const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

const call = (name: string, params: unknown) =>
	executeRegisteredMcpToolUnscoped(name, params, "mcp").pipe(Effect.result, withoutUnreachedServices)

const updatePolicy = { min_occurrence_count: 2 }

describe("read-only API key over MCP", () => {
	it.effect("runs read tools", () =>
		Effect.gen(function* () {
			const result = yield* call("get_error_notification_policy", {})
			expect(Result.isSuccess(result)).toBe(true)
		}).pipe(Effect.provide(makeLayer(true))),
	)

	it.effect("refuses a tool that changes data, naming the tool", () =>
		Effect.gen(function* () {
			const result = yield* call("update_error_notification_policy", updatePolicy)
			expect(Result.isFailure(result)).toBe(true)
			if (Result.isFailure(result)) {
				expect(result.failure).toMatchObject({
					_tag: "@maple/mcp/errors/McpAuthInvalidError",
					reason: "insufficient_scope",
				})
				expect(result.failure.message).toContain("update_error_notification_policy")
			}
		}).pipe(Effect.provide(makeLayer(true))),
	)

	it.effect("lets a full-access key change data", () =>
		Effect.gen(function* () {
			const result = yield* call("update_error_notification_policy", updatePolicy)
			expect(Result.isSuccess(result)).toBe(true)
		}).pipe(Effect.provide(makeLayer(false))),
	)
})
