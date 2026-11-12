import { Array as Arr, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { aiCreditUsageOf, AutumnGroupedAggregate } from "./ai-credit-usage"
import { camelizeKeys } from "./autumn-http"

/** Autumn's raw snake_case answer, through the client's own key renaming and the endpoint's decode. */
const decode = (raw: unknown) => Schema.decodeUnknownSync(AutumnGroupedAggregate)(camelizeKeys(raw))
const fromAutumn = (raw: unknown, byModel: unknown = { list: [] }) =>
	aiCreditUsageOf({ start: 0, end: 1 }, decode(raw), decode(byModel), null)

const day = (date: string) => Date.parse(`${date}T00:00:00Z`)

describe("aiCreditUsageOf", () => {
	it("splits the cycle's spend by source, largest first, and lists the days that spent", () => {
		const usage = fromAutumn({
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
		const usage = fromAutumn({
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
		const usage = fromAutumn({ list: [] })
		expect([usage.bySource, usage.days]).toEqual([[], []])
	})

	it("totals each model over the cycle, largest first, leaving out spend with no model", () => {
		const usage = fromAutumn(
			{ list: [] },
			{
				list: [
					{
						period: day("2026-11-02"),
						values: { ai_credits: 0.6 },
						grouped_values: {
							ai_credits: { "openrouter/a/small": 0.1, "openrouter/b/large": 0.5 },
						},
					},
					{
						period: day("2026-11-03"),
						values: { ai_credits: 0.7 },
						grouped_values: {
							ai_credits: { "openrouter/a/small": 0.7, "openrouter/c/idle": 0, "": 0.4 },
						},
					},
				],
			},
		)
		expect(
			Arr.map(usage.byModel, (entry) => [entry.model, Math.round(entry.credits * 100) / 100]),
		).toEqual([
			["openrouter/a/small", 0.8],
			["openrouter/b/large", 0.5],
		])
	})
})
