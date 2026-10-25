import { describe, expect, it } from "vitest"

import { deployMarkers, failureRows, untracedExceptions, workerOutcomeTotals } from "./worker-signals"

const outcome = (bucket: string, status: string, requests: number) => ({ bucket, status, requests })

describe("workerOutcomeTotals", () => {
	it("counts every non-success outcome as a failure and exceptions on their own", () => {
		const totals = workerOutcomeTotals([
			outcome("t1", "success", 14_000),
			outcome("t1", "scriptThrewException", 100),
			outcome("t2", "scriptThrewException", 66),
			outcome("t2", "clientDisconnected", 4),
		])
		expect(totals.invocations).toBe(14_170)
		expect(totals.failures).toBe(170)
		expect(totals.exceptions).toBe(166)
		expect(totals.byStatus[0]).toEqual({ status: "success", count: 14_000 })
	})
})

describe("failureRows", () => {
	it("leaves success out, names each way of failing, and zero-fills quiet buckets", () => {
		const rows = failureRows([
			outcome("t1", "success", 10),
			outcome("t1", "internalError", 2),
			outcome("t2", "success", 9),
		])
		expect(rows).toEqual([
			{ bucket: "t1", attributeValue: "Cloudflare internal error", value: 2 },
			{ bucket: "t2", attributeValue: "Cloudflare internal error", value: 0 },
		])
	})
})

describe("deployMarkers", () => {
	it("skips the version already running when the window opened", () => {
		const markers = deployMarkers(
			[
				{ commitSha: "93e595dea960", firstSeen: "2026-10-14T00:00:01.000Z" },
				{ commitSha: "d7a6ee72eaf8", firstSeen: "2026-10-14T11:10:38.000Z" },
			],
			"2026-10-14T00:00:00.000Z",
			300,
		)
		expect(markers.map((m) => m.label)).toEqual(["d7a6ee7"])
	})
})

describe("untracedExceptions", () => {
	it("flags exceptions the spans never recorded", () => {
		expect(untracedExceptions(166, 0)).toBe(166)
	})

	it("stays quiet when traces account for most of them", () => {
		expect(untracedExceptions(166, 150)).toBeNull()
	})

	it("says nothing when the Worker has no matching traces at all", () => {
		expect(untracedExceptions(166, null)).toBeNull()
	})
})
