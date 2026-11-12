import { afterEach, describe, expect, it } from "@effect/vitest"
import { Array as Arr, Context, Effect, Layer, Result, Schema } from "effect"
import { OrgId, RoleName, UserId, type TenantContext } from "@maple/domain/http"
import { INVESTIGATION_READ_FAMILIES } from "@maple/domain/http/v2"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { AlertDestinationsService } from "@maple/backend/services/alerts/AlertDestinationsService"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { CurrentMcpTenant } from "../../tenant"
import { executeRegisteredMcpToolUnscoped } from "../registry"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const tenant = (readOnly: boolean, scopes?: ReadonlyArray<string>, role = "root"): TenantContext => ({
	orgId: Schema.decodeSync(OrgId)("org_read_only_key"),
	userId: Schema.decodeSync(UserId)("user_read_only_key"),
	roles: [Schema.decodeSync(RoleName)(role)],
	authMode: "self_hosted",
	...(readOnly ? { readOnly: true as const } : undefined),
	...(scopes === undefined ? undefined : { scopes }),
})

const makeLayer = (readOnly: boolean, scopes?: ReadonlyArray<string>, role?: string) => {
	const database = createTestDb(createdDbs).layer
	return Layer.mergeAll(
		ErrorPolicyService.layer.pipe(Layer.provide(database)),
		database,
		Layer.succeed(CurrentMcpTenant, tenant(readOnly, scopes, role)),
		Layer.succeed(AlertDestinationsService, {
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

describe("an observer over MCP", () => {
	// A layer per test: each owns a database that `afterEach` removes.
	const observer = () => makeLayer(false, undefined, "org:observer")

	it.effect("runs read tools", () =>
		Effect.gen(function* () {
			const result = yield* call("get_error_notification_policy", {})
			expect(Result.isSuccess(result)).toBe(true)
		}).pipe(Effect.provide(observer())),
	)

	it.effect("refuses a tool that changes data and says which role can", () =>
		Effect.gen(function* () {
			const result = yield* call("update_error_notification_policy", updatePolicy)
			expect(Result.isFailure(result)).toBe(true)
			if (Result.isFailure(result)) {
				expect(result.failure._tag).toBe("@maple/mcp/errors/McpAuthInvalidError")
				expect(result.failure.message).toContain("update_error_notification_policy")
				expect(result.failure.message).toContain("Ask an org admin for the Member role")
			}
		}).pipe(Effect.provide(observer())),
	)
})

describe("a scoped key without users:read over MCP", () => {
	const scopes = Arr.map(INVESTIGATION_READ_FAMILIES, (family) => `${family}:write`)

	it.effect("still runs tools outside the users family", () =>
		Effect.gen(function* () {
			const read = yield* call("get_error_notification_policy", {})
			const write = yield* call("update_error_notification_policy", updatePolicy)
			expect(Result.isSuccess(read)).toBe(true)
			expect(Result.isSuccess(write)).toBe(true)
		}).pipe(Effect.provide(makeLayer(false, scopes))),
	)
})
