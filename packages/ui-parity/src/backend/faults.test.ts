import { Effect, Fiber, Option } from "effect"
import { describe, expect, test } from "vitest"
import { makeHolds, mergeFaults, resolveFault } from "./faults.ts"

const failure = { status: 502, body: { _tag: "Failed", message: "injected" } }

describe("faults", () => {
	test("the longest matching prefix wins", () => {
		const faults = { delays: { "queryEngine.": 10, "queryEngine.executeBatch": 60_000 } }
		expect(resolveFault(faults, "queryEngine.executeBatch").delayMs).toBe(60_000)
		expect(resolveFault(faults, "queryEngine.spanDetail").delayMs).toBe(10)
		expect(resolveFault(faults, "alerts.listRules")).toEqual({ delayMs: 0, failure: undefined })
	})

	test("scenario header faults override the dataset's per prefix", () => {
		const merged = mergeFaults(
			{ delays: { "alerts.": 5, "queryEngine.": 10 } },
			JSON.stringify({ delays: { "queryEngine.": 99 }, failures: { "alerts.": failure } }),
		)
		expect(
			Option.map(merged, (faults) => resolveFault(faults, "queryEngine.executeBatch").delayMs),
		).toEqual(Option.some(99))
		expect(Option.map(merged, (faults) => resolveFault(faults, "alerts.listRules"))).toEqual(
			Option.some({ delayMs: 5, failure }),
		)
	})

	test("a header that does not decode is refused", () => {
		expect(Option.isNone(mergeFaults(undefined, JSON.stringify({ delays: { a: "slow" } })))).toBe(true)
	})

	test("a held request counts until it is interrupted", async () => {
		const holds = makeHolds()
		const fiber = Effect.runFork(holds.hold("capture-1", 60_000))
		expect(holds.held("capture-1")).toBe(1)
		await Effect.runPromise(Fiber.interrupt(fiber))
		expect(holds.held("capture-1")).toBe(0)
	})
})
