import { DailyVolume } from "@maple/domain/http"
import { describe, expect, it } from "vitest"
import {
	DAY_MS,
	ingestWindow,
	summarizeBilling,
	summarizeIngest,
	summarizeVisits,
	visitsWindow,
} from "./snapshot"

// Cancelled mid-afternoon, so "the day of" is a partial day.
const AT = Date.parse("2026-10-07T15:30:00Z")
const dayStart = (daysAgo: number) => Date.parse("2026-10-07T00:00:00Z") - daysAgo * DAY_MS

const volume = (daysAgo: number, logsGB: number) =>
	new DailyVolume({
		date: new Date(dayStart(daysAgo)).toISOString().slice(0, 10),
		logsGB,
		tracesGB: 0,
		metricsGB: 0,
		browserSessions: 0,
	})

describe("summarizeIngest", () => {
	it("splits the series into the 30 days up to the cancellation and the 30 before", () => {
		const ingest = summarizeIngest(
			[volume(0, 1), volume(29, 2), volume(30, 4), volume(59, 8), volume(60, 100), volume(12, 0)],
			AT,
		)
		expect(ingest.recent).toMatchObject({ logsGB: 3, activeDays: 2 })
		expect(ingest.prior).toMatchObject({ logsGB: 12, activeDays: 2 })
		expect(ingest.daysSinceLastData).toBe(0)
	})

	it("reports no last-data day when nothing arrived", () => {
		expect(summarizeIngest([volume(3, 0)], AT).daysSinceLastData).toBeNull()
	})

	it("finds the last data of an org that switched off before either window", () => {
		const ingest = summarizeIngest([volume(140, 12), volume(365, 12)], AT)
		expect(ingest.daysSinceLastData).toBe(140)
		// Outside both windows: remembered, not summed.
		expect(ingest.prior).toMatchObject({ logsGB: 0, activeDays: 0 })
	})

	it("counts a day with only product events as a day telemetry arrived", () => {
		const eventsOnly = new DailyVolume({ ...volume(2, 0), productEvents: 500 })
		expect(summarizeIngest([eventsOnly], AT).daysSinceLastData).toBe(2)
	})

	it("asks the warehouse for a year ending at the cancellation", () => {
		expect(ingestWindow(AT)).toEqual({ startMs: dayStart(364), endMs: AT })
	})
})

describe("summarizeVisits", () => {
	it("leaves out the day of the cancellation, which every org spends in the app", () => {
		const visits = summarizeVisits(
			[
				{ dayMs: dayStart(0), users: 3 },
				{ dayMs: dayStart(4), users: 2 },
				{ dayMs: dayStart(30), users: 1 },
				{ dayMs: dayStart(31), users: 5 },
			],
			AT,
		)
		expect(visits.recent).toEqual({ activeDays: 2, peakDailyUsers: 2 })
		expect(visits.prior).toEqual({ activeDays: 1, peakDailyUsers: 5 })
		expect(visits.daysSinceLastVisit).toBe(4)
	})

	it("skips a bucket whose date did not parse", () => {
		const visits = summarizeVisits([{ dayMs: Number.NaN, users: 4 }], AT)
		expect(visits).toEqual({
			recent: { activeDays: 0, peakDailyUsers: 0 },
			prior: { activeDays: 0, peakDailyUsers: 0 },
			daysSinceLastVisit: null,
		})
	})

	it("ends its window where the day of the cancellation starts", () => {
		expect(visitsWindow(AT)).toEqual({ startMs: dayStart(60), endMs: dayStart(0) - 1 })
	})
})

describe("summarizeBilling", () => {
	const invoice = (createdAt: number, total: number, status = "paid") => ({ status, total, createdAt })

	it("compares the two latest invoices the org was actually billed", () => {
		const billing = summarizeBilling({
			balances: {},
			invoices: [invoice(1, 39), invoice(3, 212), invoice(4, 999, "draft"), invoice(2, 45)],
		})
		expect(billing).toEqual({
			invoices: 3,
			lastInvoiceTotal: 212,
			previousInvoiceTotal: 45,
			overAllowance: [],
		})
	})

	it("names the metered features used past their included allowance", () => {
		const billing = summarizeBilling({
			balances: {
				traces: { granted: 100, usage: 140 },
				logs: { granted: 100, usage: 60 },
				product_events: { granted: 0, usage: 9000, unlimited: true },
			},
			invoices: [],
		})
		expect(billing.overAllowance).toEqual(["traces"])
		expect(billing.lastInvoiceTotal).toBeNull()
	})
})
