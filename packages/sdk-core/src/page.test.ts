import { afterEach, describe, expect, it } from "vitest"
import {
	claimPageSignal,
	markReported,
	notifyErrorRecorded,
	onErrorRecorded,
	resetPageForTests,
	wasReported,
} from "./page"

afterEach(() => resetPageForTests())

const LINK = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1 }
const KEY = "__MAPLE_SDK_PAGE_V1__"

/** The shared state as another bundled copy of this module would see it. */
function sharedLeases(): Map<string, { owner: symbol; count: number }> {
	const state: unknown = Reflect.get(globalThis, KEY)
	const leases: unknown =
		typeof state === "object" && state !== null ? Reflect.get(state, "leases") : undefined
	if (!(leases instanceof Map)) throw new Error("no shared page state")
	return leases
}

describe("page coordination", () => {
	it("records an error object once across SDK copies", () => {
		const error = new Error("x")
		expect(wasReported(error)).toBe(false)
		markReported(error)
		expect(wasReported(error)).toBe(true)
		expect(wasReported("a string")).toBe(false)
	})

	it("tells every listener about a recorded error, and survives a throwing one", () => {
		const seen: string[] = []
		const stopBroken = onErrorRecorded(() => {
			throw new Error("listener bug")
		})
		const stop = onErrorRecorded((link) => seen.push(link.spanId))
		notifyErrorRecorded(LINK)
		stop()
		stopBroken()
		notifyErrorRecorded(LINK)
		expect(seen).toEqual([LINK.spanId])
	})

	it("leases each collector to one bundled copy until its last instance releases it", () => {
		const first = claimPageSignal("webVitals")
		const second = claimPageSignal("webVitals")
		expect(first).toBeDefined()
		expect(second).toBeDefined()
		first?.()
		first?.()
		expect(sharedLeases().get("webVitals")?.count).toBe(1)
		second?.()
		expect(sharedLeases().has("webVitals")).toBe(false)
	})

	it("refuses a collector another copy runs, and leaves the other collectors free", () => {
		sharedLeases().set("webVitals", { owner: Symbol("other copy"), count: 1 })
		expect(claimPageSignal("webVitals")).toBeUndefined()
		expect(claimPageSignal("csp")).toBeDefined()
	})

	it("starts fresh instead of misreading state an older copy wrote", () => {
		Reflect.set(globalThis, KEY, { reported: new WeakSet(), errorListeners: new Set() })
		expect(claimPageSignal("longFrames")).toBeDefined()
		expect(wasReported(new Error("y"))).toBe(false)
	})
})
