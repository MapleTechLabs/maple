import { FetchError } from "@electric-sql/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { COLLECTION_SYNC_FAILED_EVENT, createBackoffOnError } from "./collection"

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
		vi.unstubAllGlobals()
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

	it("reports an auth failure as a terminal sync failure for that collection", async () => {
		const target = new EventTarget()
		vi.stubGlobal("window", target)
		const failed: Array<unknown> = []
		target.addEventListener(COLLECTION_SYNC_FAILED_EVENT, (event) => {
			if (event instanceof CustomEvent) failed.push(event.detail)
		})
		const onError = createBackoffOnError("alerts", config, undefined)
		const unauthorized = new FetchError(401, "unauthorized", undefined, {}, "https://sync.test/v1/shape")
		expect(await onError(unauthorized)).toBeUndefined()
		expect(failed).toEqual([{ collectionId: "alerts" }])
	})
})
