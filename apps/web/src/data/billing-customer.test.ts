import { Effect, Ref } from "effect"
import { describe, expect, test } from "vitest"
import { orgLoader } from "./billing-customer"

const counting = Effect.map(Ref.make(0), (runs) => ({
	runs,
	load: Ref.updateAndGet(runs, (n) => n + 1),
}))

describe("BillingCustomerCache loader", () => {
	test("pages that name no org reuse the root's answer for the open org", () =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { runs, load } = yield* counting
					const get = yield* orgLoader(load)
					expect(yield* get({ orgId: "org_a" })).toBe(1)
					expect(yield* get()).toBe(1)
					expect(yield* get({ orgId: "org_a" })).toBe(1)
					expect(yield* Ref.get(runs)).toBe(1)
				}),
			),
		))

	test("another org or a refresh reads again", () =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { runs, load } = yield* counting
					const get = yield* orgLoader(load)
					expect(yield* get({ orgId: "org_a" })).toBe(1)
					expect(yield* get({ orgId: "org_b" })).toBe(2)
					expect(yield* get({ refresh: true })).toBe(3)
					expect(yield* get({ orgId: "org_b" })).toBe(3)
					expect(yield* Ref.get(runs)).toBe(3)
				}),
			),
		))

	test("a failed read is not kept: the next reader for the same org asks again", () =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const runs = yield* Ref.make(0)
					const load = Ref.updateAndGet(runs, (n) => n + 1).pipe(
						Effect.filterOrFail(
							(n) => n !== 1,
							() => "unreachable",
						),
					)
					const get = yield* orgLoader(load)
					expect(yield* Effect.flip(get({ orgId: "org_a" }))).toBe("unreachable")
					expect(yield* get({ orgId: "org_a" })).toBe(2)
					expect(yield* get({ orgId: "org_a" })).toBe(2)
				}),
			),
		))
})
