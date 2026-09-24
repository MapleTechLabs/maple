import { describe, expect, it } from "vitest"

import { type PeekRow, peekParamsFor, resolvePeek } from "./peek"

const row = (
	traceId: string,
	spanId: string,
	isRootSpan: boolean,
	startTime = "2026-09-14 16:00:00",
): PeekRow => ({ traceId, spanId, isRootSpan, startTime })

describe("resolvePeek", () => {
	it("is closed without a peek param", () => {
		expect(resolvePeek([row("a", "a1", true)], {})).toBeNull()
	})

	it("finds a grouped row by trace id, with its position", () => {
		const rows = [row("a", "a1", true), row("b", "b1", true), row("c", "c1", true)]
		const peek = resolvePeek(rows, { peek: "b" })
		expect(peek?.position).toEqual({ index: 1, count: 3 })
		expect(peek?.target).toEqual({ traceId: "b", startTime: "2026-09-14 16:00:00" })
	})

	it("picks the opened span row when several rows share a trace", () => {
		const rows = [
			row("x", "root", true),
			row("a", "s1", false),
			row("a", "s2", false),
			row("a", "s3", false),
		]
		expect(resolvePeek(rows, { peek: "a", peekRow: "s3" })?.position?.index).toBe(3)
		// No row hint: first match, the grouped-list behaviour.
		expect(resolvePeek(rows, { peek: "a" })?.position?.index).toBe(1)
	})

	it("still opens a trace whose row is not loaded, without a position", () => {
		const peek = resolvePeek([row("a", "a1", true)], { peek: "zzz", peekT: "2026-09-14 15:00:00" })
		expect(peek).toEqual({
			target: { traceId: "zzz", startTime: "2026-09-14 15:00:00" },
			position: null,
			row: null,
		})
	})
})

describe("peekParamsFor", () => {
	it("pins a grouped row by trace alone and a span row by its span too", () => {
		expect(peekParamsFor(row("a", "a1", true))).toEqual({
			peek: "a",
			peekT: "2026-09-14 16:00:00",
			peekRow: undefined,
		})
		expect(peekParamsFor(row("a", "s2", false)).peekRow).toBe("s2")
	})
})
