import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Ref } from "effect"
import { type LeaseSpec, pollFailureHoldUntil, pollFailureOutcome, withLease } from "./poller"

interface Row {
	readonly id: string
	readonly leaseUntil: number | null
	readonly holdUntil: number | null
}

type RowSet = Partial<Pick<Row, "leaseUntil" | "holdUntil">>

const NOW = 1_000_000
const MINUTE = 60_000

/** One in-memory row with the claim and compare-and-set a Postgres spec writes. */
const makeRow = Effect.gen(function* () {
	const row = yield* Ref.make<Row>({ id: "row_1", leaseUntil: null, holdUntil: null })
	const spec: LeaseSpec<Row, RowSet, never> = {
		leaseMs: 4 * MINUTE,
		claim: (leaseUntil, now) =>
			Ref.modify(row, (current) => {
				const free =
					(current.leaseUntil === null || current.leaseUntil < now) &&
					(current.holdUntil === null || current.holdUntil <= now)
				if (!free) return [null, current]
				const claimed = { ...current, leaseUntil }
				return [claimed, claimed]
			}),
		write: (claimed, set) =>
			Ref.modify(row, (current) =>
				current.leaseUntil === claimed.leaseUntil ? [true, { ...current, ...set }] : [false, current],
			),
		release: (holdUntil) => ({ leaseUntil: null, holdUntil }),
	}
	return { row, spec }
})

describe("withLease", () => {
	it.effect("releases with the longest hold asked for, even when the body fails", () =>
		Effect.gen(function* () {
			const { row, spec } = yield* makeRow
			const exit = yield* Effect.exit(
				withLease(spec, NOW, (lease) =>
					Effect.gen(function* () {
						yield* lease.holdFor({ _tag: "IngestRefused", message: "over the plan limit" })
						yield* lease.holdFor({ _tag: "RateLimited", message: "slow down" })
						return yield* Effect.fail("boom")
					}),
				),
			)
			assert.isTrue(Exit.isFailure(exit))
			const released = yield* Ref.get(row)
			assert.isNull(released.leaseUntil)
			assert.strictEqual(
				released.holdUntil,
				pollFailureHoldUntil({ _tag: "IngestRefused", message: "" }, NOW),
			)
			// The hold keeps the next tick out until it runs out.
			const held = yield* withLease(spec, NOW + MINUTE, () => Effect.succeed("ran"))
			assert.isTrue(Option.isNone(held))
		}),
	)

	it.effect("releases the lease when the tick is interrupted", () =>
		Effect.gen(function* () {
			const { row, spec } = yield* makeRow
			const started = yield* Deferred.make<void>()
			const fiber = yield* Effect.forkChild(
				withLease(spec, NOW, () =>
					Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
				),
			)
			yield* Deferred.await(started)
			assert.isNotNull((yield* Ref.get(row)).leaseUntil)
			yield* Fiber.interrupt(fiber)
			assert.deepStrictEqual(yield* Ref.get(row), { id: "row_1", leaseUntil: null, holdUntil: null })
		}),
	)

	it.effect("never runs the body while another tick holds the lease", () =>
		Effect.gen(function* () {
			const { spec } = yield* makeRow
			const ran = yield* Ref.make(0)
			const first = yield* Effect.forkChild(
				withLease(spec, NOW, () => Ref.update(ran, (n) => n + 1).pipe(Effect.andThen(Effect.never))),
			)
			yield* Effect.yieldNow
			const second = yield* withLease(spec, NOW, () => Ref.update(ran, (n) => n + 1))
			assert.isTrue(Option.isNone(second))
			assert.strictEqual(yield* Ref.get(ran), 1)
			yield* Fiber.interrupt(first)
		}),
	)

	it.effect("a late tick's writes never land on its successor's lease", () =>
		Effect.gen(function* () {
			const { row, spec } = yield* makeRow
			const wrote = yield* withLease(spec, NOW, (lease) =>
				Effect.gen(function* () {
					// The lease ran out and a successor claimed the row.
					yield* Ref.update(row, (current) => ({ ...current, leaseUntil: NOW + 10 * MINUTE }))
					return yield* lease.write({ holdUntil: NOW + MINUTE })
				}),
			)
			assert.deepStrictEqual(wrote, Option.some(false))
			assert.deepStrictEqual(yield* Ref.get(row), {
				id: "row_1",
				leaseUntil: NOW + 10 * MINUTE,
				holdUntil: null,
			})
		}),
	)
})

describe("PollFailure", () => {
	it("holds a rate limit for its Retry-After, but never past the longest hold", () => {
		const short = pollFailureHoldUntil({ _tag: "RateLimited", message: "", retryAfterMs: 1000 }, NOW)
		const long = pollFailureHoldUntil(
			{ _tag: "RateLimited", message: "", retryAfterMs: 20 * MINUTE },
			NOW,
		)
		const huge = pollFailureHoldUntil(
			{ _tag: "RateLimited", message: "", retryAfterMs: 24 * 60 * MINUTE },
			NOW,
		)
		assert.isNotNull(short)
		assert.strictEqual(long, NOW + 20 * MINUTE)
		assert.isAbove(long ?? 0, short ?? 0)
		assert.strictEqual(huge, pollFailureHoldUntil({ _tag: "IngestRefused", message: "" }, NOW))
	})

	it("reports a refused credential as disconnected and leaves a rate limit unreported", () => {
		assert.deepStrictEqual(pollFailureOutcome({ _tag: "Rejected", reason: "token revoked" }), {
			_tag: "Disconnected",
			reason: "token revoked",
		})
		assert.isNull(pollFailureOutcome({ _tag: "RateLimited", message: "slow down" }))
		assert.isNull(pollFailureHoldUntil({ _tag: "Upstream", message: "502" }, NOW))
	})
})
