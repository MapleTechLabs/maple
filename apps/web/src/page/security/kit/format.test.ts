import { describe, expect, it } from "vitest"
import { runTotalUsd } from "./format"

describe("runTotalUsd", () => {
	it("counts a live run's sandbox fees before its model cost settles", () => {
		expect([
			runTotalUsd({ costUsd: null, sandboxUsd: 0.18 }),
			runTotalUsd({ costUsd: 2.5, sandboxUsd: 0.5 }),
			runTotalUsd({ costUsd: null, sandboxUsd: 0 }),
		]).toEqual([0.18, 3, null])
	})
})
