import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertDestinations } from "@maple/db/tables"
import { AlertDestinationId, OrgId, RoleName, UserId } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { GetErrorNotificationPolicyOutput } from "@maple/domain/mcp-outputs"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { CurrentMcpTenant } from "../../lib/query-warehouse"
import { executeRegisteredMcpToolUnscoped } from "../registry"

const ORG = Schema.decodeUnknownSync(OrgId)("org_policy_tools")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_policy_tools_other")
const USER = Schema.decodeUnknownSync(UserId)("user_policy_tools")
const asDestinationId = Schema.decodeUnknownSync(AlertDestinationId)
const DEST = asDestinationId(randomUUID())
const FOREIGN_DEST = asDestinationId(randomUUID())

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const insertDestination = (id: AlertDestinationId, orgId: OrgId) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(AlertDestinations).values({
					id,
					orgId,
					name: `On-call ${orgId}`,
					type: "webhook",
					enabled: true,
					configJson: {},
					secretCiphertext: "ciphertext",
					secretIv: "iv",
					secretTag: "tag",
					createdAt: now,
					updatedAt: now,
					createdBy: USER,
					updatedBy: USER,
				}),
			),
		)
	})

const makeLayer = () => {
	const database = createTestDb(createdDbs).layer
	return Layer.mergeAll(
		ErrorPolicyService.layer.pipe(Layer.provide(database)),
		database,
		Layer.succeed(CurrentMcpTenant, {
			orgId: ORG,
			userId: USER,
			roles: [Schema.decodeUnknownSync(RoleName)("org:admin")],
			authMode: "self_hosted",
		} as never),
		Layer.succeed(AlertsService, {
			listDestinations: () =>
				Effect.succeed({
					destinations: [{ id: DEST, name: "On-call", type: "webhook", enabled: true }],
				}),
		} as never),
	)
}

// The registry's requirements name every tool's services; these tools reach only the ones above.
const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

const call = (name: string, params: unknown) =>
	executeRegisteredMcpToolUnscoped(name, params, "mcp").pipe(Effect.result, withoutUnreachedServices)

const readPolicy = Effect.gen(function* () {
	const result = yield* call("get_error_notification_policy", {})
	if (result._tag !== "Success") return yield* Effect.die(result.failure)
	return {
		output: Schema.decodeUnknownSync(GetErrorNotificationPolicyOutput)(result.success.structuredContent),
		text: result.success.content[0]?.text ?? "",
	}
})

const failureOf = (params: unknown) =>
	call("update_error_notification_policy", params).pipe(
		Effect.map((result) => (result._tag === "Failure" ? result.failure : undefined)),
	)

const setup = Effect.gen(function* () {
	yield* insertDestination(DEST, ORG)
	yield* insertDestination(FOREIGN_DEST, OTHER_ORG)
})

describe("error notification policy tools", () => {
	it.effect("takes a destination's REST id or its UUID, and get reads back what update wrote", () =>
		Effect.gen(function* () {
			yield* setup
			const publicId = encodePublicId(PublicIdPrefixes.alertDestination, DEST)
			yield* call("update_error_notification_policy", {
				destination_ids: [publicId],
				min_occurrence_count: 2,
			})
			const first = yield* readPolicy
			expect(first.output.destinations).toEqual([
				{ id: DEST, publicId, name: "On-call", type: "webhook", enabled: true },
			])
			expect(first.output.minOccurrenceCount).toBe(2)
			expect(first.output.firstNotificationThreshold).toBe(3)
			expect(first.text).toContain("after 3 occurrences")

			yield* call("update_error_notification_policy", { destination_ids: [], notify_on_resolve: true })
			yield* call("update_error_notification_policy", {
				destination_ids: DEST,
				min_occurrence_count: 5,
			})
			const second = yield* readPolicy
			expect(second.output.destinationIds).toEqual([DEST])
			expect(second.output.notifyOnResolve).toBe(true)
			expect(second.output.firstNotificationThreshold).toBe(5)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("rejects another resource's REST id and another org's destination as invalid input", () =>
		Effect.gen(function* () {
			yield* setup
			const dashboardId = encodePublicId(PublicIdPrefixes.dashboard, DEST)
			expect(yield* failureOf({ destination_ids: [dashboardId] })).toMatchObject({
				_tag: "@maple/mcp/errors/McpInvalidInputError",
				parameter: "destination_ids",
			})
			expect(yield* failureOf({ destination_ids: [FOREIGN_DEST] })).toMatchObject({
				_tag: "@maple/mcp/errors/McpInvalidInputError",
				parameter: "destination_ids",
			})
			expect((yield* readPolicy).output.updatedBy).toBe("system")
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("rejects a blank destination_ids instead of clearing the destinations", () =>
		Effect.gen(function* () {
			yield* setup
			yield* call("update_error_notification_policy", { destination_ids: [DEST] })
			expect(yield* failureOf({ destination_ids: "" })).toBeDefined()
			expect(yield* failureOf({ destination_ids: " , " })).toBeDefined()
			expect((yield* readPolicy).output.destinationIds).toEqual([DEST])
		}).pipe(Effect.provide(makeLayer())),
	)
})
