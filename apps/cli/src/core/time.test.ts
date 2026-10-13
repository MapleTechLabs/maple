import { describe, it } from "@effect/vitest"
import { strict as assert } from "node:assert"
import { Effect, Exit, Option, Result } from "effect"
import { normalizeTimestamp, parseTimestampMs, resolveRangeChecked, sinceToMs } from "./time"

// Plain promises: `it.effect` hangs under `bun test`. None of these cases read the clock.
const resolve = (a: { since?: string; start?: string; end?: string }) =>
	Effect.runPromise(
		Effect.exit(
			resolveRangeChecked({
				since: a.since ?? "6h",
				start: Option.fromNullishOr(a.start),
				end: Option.fromNullishOr(a.end),
			}),
		),
	)

describe("time ranges", () => {
	it("accepts m, h, d and w windows", () => {
		assert.equal(sinceToMs("30m"), 30 * 60_000)
		assert.equal(sinceToMs("2w"), 14 * 86_400_000)
		assert.equal(sinceToMs("1y"), null)
	})

	// The flag help advertised ISO-8601, which passed validation and then
	// crashed in ClickHouse with "Cannot parse string ... as DateTime".
	it("normalizes ISO-8601 and bare dates to the ClickHouse UTC form", () => {
		const ok = (input: string) => Result.getOrThrow(normalizeTimestamp(input, "--start"))
		assert.equal(ok("2026-09-25T22:00:00Z"), "2026-09-25 22:00:00")
		assert.equal(ok("2026-09-25T22:00:00.123Z"), "2026-09-25 22:00:00")
		assert.equal(ok("2026-09-26T00:00:00+02:00"), "2026-09-25 22:00:00")
		assert.equal(ok("2026-09-25 22:00:00"), "2026-09-25 22:00:00")
		assert.equal(ok("2026-09-25"), "2026-09-25 00:00:00")
	})

	it("rejects timestamps that do not exist", () => {
		assert.equal(parseTimestampMs("2026-02-31 00:00:00"), null)
		assert.equal(parseTimestampMs("tomorrow"), null)
		assert.ok(Result.isFailure(normalizeTimestamp("25/09/2026", "--end")))
	})

	it("rejects an inverted window instead of returning nothing", async () => {
		const exit = await resolve({ start: "2026-09-25T22:00:00Z", end: "2026-09-25T21:00:00Z" })
		assert.ok(Exit.isFailure(exit))
		assert.match(String(exit.cause), /--start must be before --end/)
	})

	it("looks back --since from --end when only --end is given", async () => {
		const exit = await resolve({ since: "1h", end: "2026-09-25T12:00:00Z" })
		assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value : undefined, {
			startTime: "2026-09-25 11:00:00",
			endTime: "2026-09-25 12:00:00",
		})
	})

	it("names the bad --since value", async () => {
		const exit = await resolve({ since: "1y" })
		assert.ok(Exit.isFailure(exit))
		assert.match(String(exit.cause), /invalid --since "1y"/)
	})
})
