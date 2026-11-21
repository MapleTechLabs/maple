import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, String as Str } from "effect"
import { BEFORE_FIRST_READING, type MorphDayReading, toCostRows } from "./normalize"

const reading = (
	day: string,
	memberId: string,
	openingDollars: number,
	closingDollars: number,
): MorphDayReading => ({
	month: Str.slice(0, 7)(day),
	day,
	memberId,
	memberLabel: `${memberId}@example.com`,
	openingMicros: Math.round(openingDollars * 1_000_000),
	closingMicros: Math.round(closingDollars * 1_000_000),
})

const NOVEMBER = { startDay: "2026-11-01", endDay: "2026-11-30" }

const summary = (rows: ReturnType<typeof toCostRows>) =>
	Arr.map(rows, (row) => ({
		day: row.day,
		member: row.resourceId,
		usage: row.usageType,
		cost: Math.round(row.billedCost * 100) / 100,
		category: row.chargeCategory,
		estimated: row.estimated,
	}))

describe("Morph readings as daily cost", () => {
	it("books the spend before the month's first reading on its first day, then each day's change", () => {
		const rows = toCostRows(
			[
				reading("2026-11-21", "dev", 77.86, 80),
				reading("2026-11-22", "dev", 80.5, 84.25),
				reading("2026-11-23", "dev", 84.25, 85),
			],
			"organization",
			NOVEMBER,
			"2026-11-23",
		)
		assert.deepStrictEqual(summary(rows), [
			{
				day: "2026-11-01",
				member: "dev@example.com",
				usage: BEFORE_FIRST_READING,
				cost: 77.86,
				category: "usage",
				estimated: false,
			},
			{
				day: "2026-11-21",
				member: "dev@example.com",
				usage: "Usage",
				cost: 2.14,
				category: "usage",
				estimated: false,
			},
			// From the day before's last reading, so spend between two days' readings is not lost.
			{
				day: "2026-11-22",
				member: "dev@example.com",
				usage: "Usage",
				cost: 4.25,
				category: "usage",
				estimated: false,
			},
			{
				day: "2026-11-23",
				member: "dev@example.com",
				usage: "Usage",
				cost: 0.75,
				category: "usage",
				estimated: true,
			},
		])
		// The month adds up to Morph's own total.
		assert.strictEqual(
			Math.round(Arr.reduce(rows, 0, (total, row) => total + row.billedCost) * 100) / 100,
			85,
		)
	})

	it("counts a member who joins later from zero, and books a day with no reading on the next one", () => {
		const rows = toCostRows(
			[
				reading("2026-11-10", "dev", 5, 6),
				reading("2026-11-13", "dev", 9, 10),
				reading("2026-11-12", "ops", 1, 3),
				// The newest email names the member on every day.
				{ ...reading("2026-11-13", "ops", 3, 3), memberLabel: "ops-renamed@example.com" },
			],
			"organization",
			NOVEMBER,
			"2026-11-13",
		)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.day, row.resourceId, row.usageType, row.billedCost]),
			[
				["2026-11-01", "dev@example.com", BEFORE_FIRST_READING, 5],
				["2026-11-10", "dev@example.com", "Usage", 1],
				["2026-11-13", "dev@example.com", "Usage", 4],
				["2026-11-12", "ops-renamed@example.com", "Usage", 3],
			],
		)
	})

	it("keeps two members apart when one takes over the other's email", () => {
		const rows = toCostRows(
			[
				reading("2026-11-16", "alex", 0, 4),
				reading("2026-11-16", "sam", 0, 9),
				// Alex left; Sam took Alex's address.
				{ ...reading("2026-11-17", "sam", 9, 10), memberLabel: "alex@example.com" },
			],
			"organization",
			NOVEMBER,
			"2026-11-17",
		)
		const monday = Arr.filter(rows, (row) => row.day === "2026-11-16")
		assert.deepStrictEqual(
			Arr.map(monday, (row) => [row.resourceId, row.billedCost]),
			[
				["alex@example.com (alex)", 4],
				["alex@example.com (sam)", 9],
			],
		)
	})

	it("starts every month over, and returns only the window's days", () => {
		const rows = toCostRows(
			[
				reading("2026-11-29", "dev", 40, 45),
				reading("2026-11-30", "dev", 45, 50),
				// The new month's first reading, minutes after midnight.
				reading("2026-12-01", "dev", 0.1, 2),
				reading("2026-12-02", "dev", 2, 3),
			],
			"organization",
			{ startDay: "2026-11-30", endDay: "2026-12-02" },
			"2026-12-02",
		)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.day, row.usageType, Math.round(row.billedCost * 100) / 100]),
			[
				["2026-11-30", "Usage", 5],
				// Read on the month's first day: nothing was missed, so it all counts as that day's.
				["2026-12-01", "Usage", 2],
				["2026-12-02", "Usage", 1],
			],
		)
	})

	it("writes a drop in the month's spend as an adjustment and skips days that did not move", () => {
		const rows = toCostRows(
			[
				reading("2026-11-01", "dev", 0, 10),
				reading("2026-11-02", "dev", 10, 10),
				reading("2026-11-03", "dev", 10, 7),
			],
			"organization",
			NOVEMBER,
			"2026-11-03",
		)
		assert.deepStrictEqual(summary(rows), [
			{
				day: "2026-11-01",
				member: "dev@example.com",
				usage: "Usage",
				cost: 10,
				category: "usage",
				estimated: false,
			},
			{
				day: "2026-11-03",
				member: "dev@example.com",
				usage: "Usage",
				cost: -3,
				category: "adjustment",
				estimated: true,
			},
		])
	})
})
