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
})
