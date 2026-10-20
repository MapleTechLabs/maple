import { Effect, Ref } from "effect"
import { describe, expect, test } from "vitest"
import { sharedLoader } from "./integration-statuses"

/** A load that fails on the runs listed in `failing` and answers with the run number otherwise. */
const counting = (failing: ReadonlyArray<number>) =>
	Effect.map(Ref.make(0), (runs) => ({
		runs,
		load: Effect.flatMap(Ref.updateAndGet(runs, (n) => n + 1), (run) =>
			failing.includes(run) ? Effect.fail(`run ${run} failed`) : Effect.succeed(run),
		),
	}))

describe("IntegrationStatuses loader", () => {
	test("a settled status is shared until a reader asks for a refresh", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const { runs, load } = yield* counting([])
				const status = yield* sharedLoader(load)
				expect(yield* status()).toBe(1)
				expect(yield* status()).toBe(1)
				expect(yield* status({ refresh: true })).toBe(2)
				expect(yield* Ref.get(runs)).toBe(2)
			}),
		))

	test("an answer is kept per org: another org asks again", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const { runs, load } = yield* counting([])
				const status = yield* sharedLoader(load)
				expect(yield* status({ orgId: "org_a" })).toBe(1)
				expect(yield* status({ orgId: "org_b" })).toBe(2)
				expect(yield* status({ orgId: "org_b" })).toBe(2)
				expect(yield* Ref.get(runs)).toBe(2)
			}),
		))

	test("a failed load is not kept: the next reader asks again", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const { runs, load } = yield* counting([1])
				const status = yield* sharedLoader(load)
				expect(yield* Effect.flip(status())).toBe("run 1 failed")
				expect(yield* status()).toBe(2)
				expect(yield* status()).toBe(2)
				expect(yield* Ref.get(runs)).toBe(2)
			}),
		))
})
