import { afterEach, describe, expect, it } from "vitest"
import {
	claimPageSignal,
	leasePageSignalAsOtherCopyForTests,
	markReported,
	notifyErrorRecorded,
	onErrorRecorded,
	pageSignalLeasesForTests,
	resetPageForTests,
	wasReported,
} from "./page"

afterEach(() => resetPageForTests())

const LINK = { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1 }
const KEY = "__MAPLE_SDK_PAGE_V1__"

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
		expect(pageSignalLeasesForTests("webVitals")).toBe(1)
		second?.()
		expect(pageSignalLeasesForTests("webVitals")).toBe(0)
		expect(claimPageSignal("webVitals")).toBeDefined()
	})

	it("refuses a collector another copy runs, and leaves the other collectors free", () => {
		leasePageSignalAsOtherCopyForTests("webVitals")
		expect(claimPageSignal("webVitals")).toBeUndefined()
		expect(claimPageSignal("csp")).toBeDefined()
	})

	it("starts fresh instead of misreading state an older copy wrote", () => {
		Object.assign(globalThis, { [KEY]: { reported: new WeakSet(), errorListeners: new Set() } })
		expect(claimPageSignal("longFrames")).toBeDefined()
		expect(wasReported(new Error("y"))).toBe(false)
	})
})
