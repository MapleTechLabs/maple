import { assert, describe, it } from "@effect/vitest"
import { Duration } from "effect"
import {
	backoffLogMessage,
	classifyTargetStatus,
	DELIVERY_BLOCKED_BACKOFF,
	MAX_BACKOFF,
	nextScrapeDelayMs,
	shouldBackOff,
	startJitterMs,
	type FailureSignal,
} from "./policy"
import type { ScrapeFailureReason } from "./ScrapeError"

const REASONS: ReadonlyArray<ScrapeFailureReason> = [
	"rate_limited",
	"auth_failed",
	"delivery_blocked",
	"target_error",
	"scrape_failed",
]

const failed = (reason: ScrapeFailureReason, retryAfterMs: number | null = null): FailureSignal => ({
	reason,
	retryAfterMs,
})

describe("classifyTargetStatus", () => {
	it("maps target statuses to reasons", () => {
		assert.deepStrictEqual([429, 503, 401, 403, 500, 502, 504, 404, 400].map(classifyTargetStatus), [
			"rate_limited",
			"rate_limited",
			"auth_failed",
			"auth_failed",
			"target_error",
			"target_error",
			"target_error",
			"scrape_failed",
			"scrape_failed",
		])
	})
})

describe("shouldBackOff", () => {
	it("backs off for every reason a retry cannot immediately clear, and only those", () => {
		assert.deepStrictEqual(
			REASONS.map((reason) => shouldBackOff(failed(reason))),
			[true, true, true, true, false],
		)
		assert.isFalse(shouldBackOff(null))
	})
})

describe("nextScrapeDelayMs", () => {
	const delay = (failure: FailureSignal | null, consecutiveBackoffs: number, baseMs = 10_000) =>
		nextScrapeDelayMs({ baseMs, failure, consecutiveBackoffs })
	const maxMs = Duration.toMillis(MAX_BACKOFF)
	const blockedMs = Duration.toMillis(DELIVERY_BLOCKED_BACKOFF)

	it("holds the base interval on success and on scrape_failed, ignoring the counter", () => {
		assert.strictEqual(delay(null, 3), 10_000)
		assert.strictEqual(delay(failed("scrape_failed"), 4), 10_000)
	})

	it("doubles per consecutive backoff for every backing-off reason", () => {
		for (const reason of ["rate_limited", "auth_failed", "target_error"] as const) {
			assert.deepStrictEqual(
				[0, 1, 3].map((n) => delay(failed(reason), n)),
				[10_000, 20_000, 80_000],
			)
		}
	})

	it("caps the ladder at five minutes", () => {
		assert.strictEqual(delay(failed("rate_limited"), 5, 60_000), maxMs)
	})

	it("honors a longer Retry-After and ignores a shorter one", () => {
		assert.strictEqual(delay(failed("rate_limited", 120_000), 0), 120_000)
		assert.strictEqual(delay(failed("rate_limited", 5_000), 2), 40_000)
	})

	// A 402 clears only when a human fixes the subscription; probing hourly
	// instead of climbing the 5-minute ladder saves 11 of every 12 scrapes.
	it("parks a billing block flat, independent of interval and history", () => {
		assert.strictEqual(delay(failed("delivery_blocked"), 0), blockedMs)
		assert.strictEqual(delay(failed("delivery_blocked"), 5, 300_000), blockedMs)
		assert.isAbove(blockedMs, maxMs)
	})
})

describe("backoffLogMessage", () => {
	it("gives each reason its own line", () => {
		assert.lengthOf(new Set(REASONS.map(backoffLogMessage)), REASONS.length)
		assert.include(backoffLogMessage("delivery_blocked"), "delivery")
	})
})

describe("startJitterMs", () => {
	it("stays within [0, baseMs) and is deterministic for a key", () => {
		const jitter = startJitterMs("target_a:branch-1", 30_000)
		assert.isAtLeast(jitter, 0)
		assert.isBelow(jitter, 30_000)
		assert.strictEqual(startJitterMs("target_a:branch-1", 30_000), jitter)
	})

	it("spreads keys sharing an interval", () => {
		const offsets = ["a:", "b:", "a:branch-1", "a:branch-2"].map((key) => startJitterMs(key, 30_000))
		assert.lengthOf(new Set(offsets), offsets.length)
	})

	it("returns 0 when the interval is non-positive", () => {
		assert.strictEqual(startJitterMs("a:", 0), 0)
	})
})
