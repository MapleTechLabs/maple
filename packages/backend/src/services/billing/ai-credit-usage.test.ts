import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { aiCreditUsageOf } from "./ai-credit-usage"

const day = (date: string) => Date.parse(`${date}T00:00:00Z`)

describe("aiCreditUsageOf", () => {
	it("splits the cycle's spend by source, largest first, and lists the days that spent", () => {
		const usage = aiCreditUsageOf({
			list: [
				{
					period: day("2026-11-02"),
					values: { ai_credits: 0.5 },
					grouped_values: { ai_credits: { chat: 0.2, triage: 0.3 } },
				},
				{
					period: day("2026-11-03"),
					values: { ai_credits: 0 },
					grouped_values: { ai_credits: {} },
				},
				{
					period: day("2026-11-04"),
					values: { ai_credits: 1.25 },
					grouped_values: { ai_credits: { review: 1, chat: 0.25, triage: 0 } },
				},
			],
		})
		expect(Arr.map(usage.bySource, (entry) => [entry.source, entry.credits])).toEqual([
			["review", 1],
			["chat", 0.45],
			["triage", 0.3],
		])
		expect(Arr.map(usage.days, (entry) => [entry.date, entry.credits])).toEqual([
			["2026-11-02", 0.5],
			["2026-11-04", 1.25],
		])
	})

	it("folds Autumn's overflow bucket and unknown sources into other", () => {
		const usage = aiCreditUsageOf({
			list: [
				{
					period: day("2026-11-02"),
					values: { ai_credits: 3 },
					grouped_values: { ai_credits: { Other: 1, "": 0.5, security_audit: 1.5 } },
				},
			],
		})
		expect(Arr.map(usage.bySource, (entry) => [entry.source, entry.credits])).toEqual([
			["security_audit", 1.5],
			["other", 1.5],
		])
	})

	it("reads an empty cycle as nothing spent", () => {
		const usage = aiCreditUsageOf({ list: [] })
		expect([usage.bySource, usage.days]).toEqual([[], []])
	})
})
