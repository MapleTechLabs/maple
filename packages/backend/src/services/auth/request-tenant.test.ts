import { assert, describe, it } from "@effect/vitest"
import { CachePartition } from "@maple/cache"
import { CurrentTenant, OrgId, UserId } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Effect, Fiber, Schema } from "effect"
import { CurrentDataScope } from "@maple/backend/services/warehouse/data-scope"
import { provideRequestTenant } from "./request-tenant"

const tenant = (permissions: ReadonlyArray<Policy.Permission>, namespaces?: ReadonlyArray<string>) =>
	new CurrentTenant.TenantSchema({
		orgId: Schema.decodeSync(OrgId)("org_request"),
		userId: Schema.decodeSync(UserId)("user_request"),
		roles: [],
		permissions,
		...(namespaces === undefined ? undefined : { namespaces }),
		authMode: "clerk",
	})

/** What a handler sees: its tenant, the data scope of its reads and its cache partition. */
const seen = Effect.gen(function* () {
	return {
		permissions: (yield* CurrentTenant.Context).permissions,
		scope: yield* CurrentDataScope,
		partition: yield* CachePartition,
	}
})

describe("provideRequestTenant", () => {
	it.effect("leaves a caller who reads all telemetry unlimited and unpartitioned", () =>
		Effect.gen(function* () {
			const handler = yield* seen.pipe(provideRequestTenant(tenant(Policy.grantsOf(["org:analyst"]))))
			assert.deepStrictEqual(handler.scope, Policy.ALL_DATA)
			assert.isUndefined(handler.partition)
		}),
	)

	it.effect(
		"keeps a limited caller's whole request to its namespaces, in a cache partition of its own",
		() =>
			Effect.gen(function* () {
				const checkout = yield* seen.pipe(
					provideRequestTenant(tenant([Policy.SCOPED_READ], ["checkout"])),
				)
				const search = yield* seen.pipe(
					provideRequestTenant(tenant([Policy.SCOPED_READ], ["search"])),
				)
				assert.deepStrictEqual(checkout.scope, { _tag: "Namespaces", namespaces: ["checkout"] })
				assert.isDefined(checkout.partition)
				assert.notStrictEqual(checkout.partition, search.partition)
			}),
	)

	it.effect("shares a partition between two callers limited to the same namespaces", () =>
		Effect.gen(function* () {
			const one = yield* seen.pipe(provideRequestTenant(tenant([Policy.SCOPED_READ], ["a", "b"])))
			const other = yield* seen.pipe(provideRequestTenant(tenant([Policy.SCOPED_READ], ["b", "a"])))
			assert.strictEqual(one.partition, other.partition)
		}),
	)

	// A pinned key, or a tenant built without them: the scoped read alone reads nothing.
	it.effect("reads no namespace when a limited caller arrives without its namespaces", () =>
		Effect.gen(function* () {
			const handler = yield* seen.pipe(provideRequestTenant(tenant([Policy.SCOPED_READ])))
			assert.deepStrictEqual(handler.scope, { _tag: "Namespaces", namespaces: [] })
		}),
	)

	it.effect("carries the scope into work the handler forks", () =>
		Effect.gen(function* () {
			const readScope = Effect.map(seen, (handler) => handler.scope)
			const forked = yield* Effect.gen(function* () {
				const child = yield* Effect.forkChild(readScope)
				const detached = yield* Effect.forkDetach(readScope)
				return [yield* Fiber.join(child), yield* Fiber.join(detached)]
			}).pipe(provideRequestTenant(tenant([Policy.SCOPED_READ], ["checkout"])))
			const checkout = { _tag: "Namespaces", namespaces: ["checkout"] }
			assert.deepStrictEqual(forked, [checkout, checkout])
		}),
	)
})
