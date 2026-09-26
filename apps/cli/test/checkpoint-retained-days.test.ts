import { describe, it } from "@effect/vitest"
import { strictEqual } from "node:assert"
import { retainedDaysMatch, type RetainedDays } from "../src/server/checkpoints"

const TABLES = [
	"logs",
	"traces",
	"metrics_sum",
	"metrics_gauge",
	"metrics_histogram",
	"metrics_exponential_histogram",
]

// Every raw table at a 30-day TTL, with the given per-day counts on each.
const measured = (countedOn: string, days: Record<string, number>): RetainedDays => ({
	countedOn,
	tables: Object.fromEntries(TABLES.map((table) => [table, { ttlDays: 30, days }])),
})

describe("checkpoint validation per-day counts", () => {
	it("ignores days TTL may have dropped between two opens", () => {
		// 2026-08-12 expired long before 2026-09-26: one open still had its rows, the other merged them away.
		const before = measured("2026-09-26", { "2026-08-12": 4, "2026-09-26": 10 })
		const after = measured("2026-09-26", { "2026-09-26": 10 })
		strictEqual(retainedDaysMatch(before, after), true)
	})

	it("still catches a lost row on any day clear of expiry", () => {
		const before = measured("2026-09-26", { "2026-09-20": 5, "2026-09-26": 10 })
		const after = measured("2026-09-26", { "2026-09-20": 4, "2026-09-26": 10 })
		strictEqual(retainedDaysMatch(before, after), false)
	})

	it("compares from the later measurement day when a restore runs days after creation", () => {
		// Created 09-01, restored 09-20: 08-22 is within 2 days of expiry on 09-20, so it may shrink.
		const created = measured("2026-09-01", { "2026-08-22": 7, "2026-09-01": 3 })
		const restored = measured("2026-09-20", { "2026-08-22": 2, "2026-09-01": 3 })
		strictEqual(retainedDaysMatch(created, restored), true)
		strictEqual(
			retainedDaysMatch(created, measured("2026-09-20", { "2026-08-22": 2, "2026-09-01": 1 })),
			false,
		)
	})
})
