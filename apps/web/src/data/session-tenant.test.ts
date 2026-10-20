import { CurrentTenant } from "@maple/domain/http"
import { Effect, Option, Ref, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { makeSessionTenantCache } from "./session-tenant"

const tenant = Schema.decodeUnknownSync(CurrentTenant.TenantSchema)({
	orgId: "org_parity",
	userId: "user_ada",
	roles: ["root"],
	authMode: "self_hosted",
})

describe("session tenant cache", () => {
	test("a failed read is asked again by the next reader; a good one is shared", async () => {
		const outcome = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const reads = yield* Ref.make(0)
					const fetchTenant = Effect.flatMap(Ref.updateAndGet(reads, (count) => count + 1), (count) =>
						count === 1 ? Effect.fail("network blip") : Effect.succeed(tenant),
					)
					const cache = yield* makeSessionTenantCache(fetchTenant, Effect.succeed(Option.some("token_1")))
					const first = yield* Effect.result(cache.get)
					const second = yield* cache.get
					yield* cache.get
					return { isFirstFailure: first._tag === "Failure", second, reads: yield* Ref.get(reads) }
				}),
			),
		)
		expect(outcome.isFirstFailure).toBe(true)
		expect(outcome.second.userId).toBe("user_ada")
		expect(outcome.reads).toBe(2)
	})
})
