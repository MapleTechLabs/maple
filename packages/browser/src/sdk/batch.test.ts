import { afterEach, describe, expect, it, vi } from "vitest"
import { BatchQueue } from "./batch"
import type { ExportResult } from "./span"

afterEach(() => vi.useRealTimers())

describe("BatchQueue.forceFlush", () => {
	it("waits for the scheduled export already in flight, so an exit flush covers it", async () => {
		vi.useFakeTimers()
		const results: Array<(result: ExportResult) => void> = []
		const queue = new BatchQueue<string>(
			{ export: (_items, callback) => void results.push(callback), shutdown: () => Promise.resolve() },
			1_000,
			true,
		)
		queue.add("a")
		await vi.advanceTimersByTimeAsync(1_000)
		expect(results).toHaveLength(1)

		let flushed = false
		void queue.forceFlush().then(() => {
			flushed = true
		})
		await vi.advanceTimersByTimeAsync(0)
		expect(flushed).toBe(false)

		results[0]?.({ code: 0 })
		await vi.advanceTimersByTimeAsync(0)
		expect(flushed).toBe(true)
	})
})

describe("BatchQueue for log records", () => {
	it("fails an export that throws synchronously at once, and keeps exporting later batches", async () => {
		const exported: string[][] = []
		let calls = 0
		const queue = new BatchQueue<string>(
			{
				export(items: string[], callback: (result: ExportResult) => void): void {
					calls += 1
					// What serializing a cyclic log body does: throw before any request is made.
					if (calls === 1) throw new RangeError("Maximum call stack size exceeded")
					exported.push(items)
					callback({ code: 0 })
				},
				shutdown: () => Promise.resolve(),
			},
			60_000,
			false,
		)

		queue.add("cyclic")
		// Settles rather than waiting out the 30s export timeout.
		await queue.forceFlush()
		queue.add("next")
		await queue.forceFlush()

		expect(exported).toEqual([["next"]])
		await queue.shutdown()
	})
})
