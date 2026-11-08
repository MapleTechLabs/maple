import { FetchError } from "@electric-sql/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createBackoffOnError } from "./collection"

const config = {
	initialDelayMs: 1,
	maxDelayMs: 4,
	multiplier: 2,
	maxRetries: 1,
	jitter: false,
	resetTimeoutMs: 10,
}

const networkError = () => new FetchError(503, "unavailable", undefined, {}, "https://sync.test/v1/shape")

describe("createBackoffOnError", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	/** One onError call, with the backoff sleep run out. */
	const fail = async (onError: ReturnType<typeof createBackoffOnError>) => {
		const answer = onError(networkError())
		await vi.advanceTimersByTimeAsync(config.maxDelayMs)
		return answer
	}

	it("retries within the budget, then stops for good", async () => {
		const onError = createBackoffOnError("alerts", config, undefined)
		expect(await fail(onError)).toEqual({})
		expect(await fail(onError)).toBeUndefined()

		// The reset scheduled by the first retry would have restored the budget.
		await vi.advanceTimersByTimeAsync(config.resetTimeoutMs * 2)
		expect(await fail(onError)).toBeUndefined()
	})

	it("restores the budget once a stream has gone quiet for the reset timeout", async () => {
		const onError = createBackoffOnError("alerts", config, undefined)
		expect(await fail(onError)).toEqual({})
		await vi.advanceTimersByTimeAsync(config.resetTimeoutMs)
		expect(await fail(onError)).toEqual({})
	})
})
