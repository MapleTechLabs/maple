import { describe, expect, it } from "vitest"
import { BatchQueue } from "./batch"
import type { ExportResult } from "./span"

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
