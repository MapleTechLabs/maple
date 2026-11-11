import { describe, expect, it } from "vitest"
import { Array as Arr, String as Str } from "effect"
import { clusterVercelErrorLogs, errorPatternSearch, type VercelErrorLogRow } from "./vercel-errors"

const row = (minute: number, body: string, traceId = ""): VercelErrorLogRow => ({
	timestamp: `2026-11-10T13:${Str.padStart(2, "0")(String(minute))}:00.000Z`,
	body,
	source: "lambda",
	traceId,
	spanId: "",
})

const invocation = (id: string, page: string) =>
	`START RequestId: ${id} [GET] /api/hello?page=${page} status=500 END RequestId: ${id} REPORT RequestId: ${id} Duration: 41.2 ms`

describe("clusterVercelErrorLogs", () => {
	// Newest first, as the read returns them.
	const rows = [
		row(59, invocation("9610b6ff-ae05-4e9a-b8c8-061ed8fe0787", "blog"), "4bf92f3577b34da6a3ce929d0e0e4736"),
		row(58, "quote failed Error: upstream parse failed at handler (file:///var/task/api/quote.js:7:37)"),
		row(57, invocation("66add16b-b35e-44a2-8477-2ba36ee587de", "index"), "00000000000000000000000000000000"),
		row(56, invocation("3964ffe7-35bf-4100-b021-3cb78b81d8e6", "about")),
		row(55, "quote failed Error: upstream parse failed at handler (file:///var/task/api/quote.js:7:37)"),
	]

	it("groups lines that differ only in ids and values, most frequent first", () => {
		const patterns = clusterVercelErrorLogs(rows)
		expect(Arr.map(patterns, (p) => p.occurrences)).toEqual([3, 2])
		expect(patterns[0]?.pattern).toContain("START RequestId: <uuid>")
		expect(patterns[0]?.pattern).not.toContain("9610b6ff")
	})

	it("keeps the newest line of each pattern, in full, with its trace", () => {
		const [invocations, quote] = clusterVercelErrorLogs(rows)
		expect(invocations?.sample).toBe(invocation("9610b6ff-ae05-4e9a-b8c8-061ed8fe0787", "blog"))
		expect(invocations?.lastSeen).toBe("2026-11-10T13:59:00.000Z")
		expect(invocations?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
		expect(quote?.traceId).toBeNull()
	})

	it("treats an all-zero trace id as none", () => {
		const [only] = clusterVercelErrorLogs([row(1, "boom", "00000000000000000000000000000000")])
		expect(only?.traceId).toBeNull()
	})
})

describe("errorPatternSearch", () => {
	it("searches the longest literal run of the pattern", () => {
		expect(errorPatternSearch("START RequestId: <uuid> [GET] /api/hello?page=<*> status=500")).toBe(
			"[GET] /api/hello?page=",
		)
	})

	it("has nothing to search when no run is distinctive", () => {
		expect(errorPatternSearch("<*> <*> ok <*>")).toBeNull()
	})
})
