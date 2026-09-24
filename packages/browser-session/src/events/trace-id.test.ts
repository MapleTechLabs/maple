import { describe, expect, it } from "vitest"
import { noteStartedTraceId, withStartedTraceId } from "./trace-id"

describe("withStartedTraceId", () => {
	it("returns the first trace id started during the call", () => {
		const { result, traceId } = withStartedTraceId(() => {
			noteStartedTraceId("a".repeat(32))
			noteStartedTraceId("b".repeat(32))
			return 7
		})
		expect(result).toBe(7)
		expect(traceId).toBe("a".repeat(32))
	})

	it("reports nothing when no span started, and ignores spans outside the call", () => {
		noteStartedTraceId("c".repeat(32))
		expect(withStartedTraceId(() => undefined).traceId).toBeUndefined()
	})

	it("closes its slot when the call throws", () => {
		expect(() =>
			withStartedTraceId(() => {
				throw new Error("sync failure")
			}),
		).toThrow("sync failure")
		expect(withStartedTraceId(() => undefined).traceId).toBeUndefined()
	})
})
