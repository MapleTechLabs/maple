import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, String as Str } from "effect"
import { DAY_MS, END_MS, START_MS, SECRET, budget, prepare, request, run } from "./clerk.test-support"
import { makeFakeClerk, seedClerkUsers } from "./testing"

// 600 users over 60 days: 10 signups a day, half of them inside the 30-day window.
const seeded = () =>
	makeFakeClerk({ secretKey: SECRET, users: seedClerkUsers(600, START_MS - 30 * DAY_MS, END_MS) })
// 24,000 users over 60 days: 12,000 inside the window, more than a scan may read.
const crowded = () =>
	makeFakeClerk({ secretKey: SECRET, users: seedClerkUsers(24_000, START_MS - 30 * DAY_MS, END_MS) })
const HOURLY = request({ window: { startMs: START_MS, endMs: END_MS, granularitySeconds: 3600 } })
const SIGNUPS_PER_DAY = {
	_tag: "resource",
	resource: "users",
	measure: { fn: "count" },
	groupBy: { time: "created_at" },
} as const

describe("Clerk count plans", () => {
	it.effect("charts signups per day by reading a small total once instead of counting each day", () =>
		Effect.gen(function* () {
			const fake = seeded()
			const { summary, table } = yield* run(fake, SIGNUPS_PER_DAY)
			expect(summary).toMatchObject({ strategy: "count", calls: 31 })
			expect(Arr.map(fake.calls, (c) => c.path)).toEqual(["/users/count", "/users"])
			expect(table.columns).toEqual([
				{ name: "bucket", type: "timestamp" },
				{ name: "count", type: "number" },
			])
			expect(table.rows).toHaveLength(30)
			expect(table.rows[0]).toEqual({ bucket: new Date(START_MS).toISOString(), count: 10 })
			expect(Arr.every(table.rows, (row) => row.count === 10)).toBe(true)
		}),
	)

	it.effect("counts each day with one total call per day when too many users match to read", () =>
		Effect.gen(function* () {
			const fake = crowded()
			const { table } = yield* run(fake, SIGNUPS_PER_DAY)
			expect(Arr.map(fake.calls, (c) => c.path)).toEqual(Arr.replicate("/users/count", 31))
			expect(table.rows).toHaveLength(30)
			expect(Arr.every(table.rows, (row) => row.count === 400)).toBe(true)
		}),
	)

	it.effect("answers an hourly chart over 30 days by reading the few matching users", () =>
		Effect.gen(function* () {
			const fake = seeded()
			const { table } = yield* run(fake, SIGNUPS_PER_DAY, HOURLY)
			expect(fake.calls).toHaveLength(2)
			expect(table.rows).toHaveLength(720)
			expect(Arr.reduce(table.rows, 0, (sum, row) => sum + Number(row.count))).toBe(300)
		}),
	)

	it.effect("refuses an hourly chart after one call when neither plan fits, and says how to fix it", () =>
		Effect.gen(function* () {
			const fake = crowded()
			const error = yield* Effect.flip(run(fake, SIGNUPS_PER_DAY, HOURLY))
			expect(fake.calls).toHaveLength(1)
			expect(error._tag).toBe("@maple/data-sources/Limit")
			expect(error.message).toContain("720 API calls")
			expect(error.message).toContain("group by day instead of hour")
		}),
	)

	it.effect("counts all users with one call", () =>
		Effect.gen(function* () {
			const fake = seeded()
			const { table } = yield* run(fake, {
				_tag: "resource",
				resource: "users",
				measure: { fn: "count" },
				filters: [{ field: "created_at", op: "gte", value: 0 }],
			})
			expect(table.rows).toEqual([{ count: 600 }])
			expect(fake.calls).toHaveLength(1)
		}),
	)

	it.effect("refuses a per-day history of last_active_at and says what is answerable", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				prepare({
					_tag: "resource",
					resource: "users",
					measure: { fn: "count" },
					groupBy: { time: "last_active_at" },
				}),
			)
			expect(error._tag).toBe("@maple/data-sources/Validation")
			expect(error.message).toContain("most recent value")
			expect(error.message).toContain("within_window")
		}),
	)
})

describe("Clerk budgets and failures", () => {
	it.effect("stops calling once Maple's share of the rate limit is spent", () =>
		Effect.gen(function* () {
			const fake = crowded()
			const { state, context } = budget(12)
			const error = yield* Effect.flip(run(fake, SIGNUPS_PER_DAY, request(), context))
			expect(error._tag).toBe("@maple/data-sources/RateLimited")
			expect(fake.calls.length).toBe(state.spent)
			expect(fake.calls.length).toBeLessThanOrEqual(12)
		}),
	)

	it.effect("maps Clerk's 429 to RateLimited with Retry-After", () =>
		Effect.gen(function* () {
			const fake = makeFakeClerk({ secretKey: SECRET, users: [], throttleAfter: 0 })
			const error = yield* Effect.flip(run(fake, SIGNUPS_PER_DAY))
			expect(error).toMatchObject({ _tag: "@maple/data-sources/RateLimited", retryAfterSeconds: 7 })
		}),
	)

	it.effect("reports a rejected key as an auth failure without echoing the key", () =>
		Effect.gen(function* () {
			const fake = makeFakeClerk({ secretKey: "sk_test_SomeOtherKey", users: [] })
			const error = yield* Effect.flip(run(fake, SIGNUPS_PER_DAY))
			expect(error).toMatchObject({ _tag: "@maple/data-sources/Connection", reason: "auth" })
			expect(JSON.stringify(error)).not.toContain(SECRET)
			expect(error.message).not.toContain(SECRET)
			expect(
				Arr.flatMap(fake.calls, (call) =>
					Arr.filter(call.params, ([, value]) => Str.includes("sk_")(value)),
				),
			).toEqual([])
		}),
	)
})
