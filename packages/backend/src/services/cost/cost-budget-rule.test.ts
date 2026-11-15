import { describe, expect, it } from "vitest"
import { costBudgetProgress } from "@maple/domain/cost-budget"
import type { CostBudgetDefinition } from "@maple/domain/http"
import { AlertDestinationId, AlertRuleId } from "@maple/primitives"
import { Array as Arr, Option, Schema } from "effect"
import {
	type CostBudgetRuleRow,
	costBudgetFromRow,
	costBudgetRuleFields,
	evaluateCostBudget,
} from "./cost-budget-rule"

const asDestinationId = Schema.decodeSync(AlertDestinationId)
const RULE_ID = Schema.decodeSync(AlertRuleId)("3f0e1c52-6d0b-4d3e-9b1a-2f4c5d6e7a8b")
const SLACK = asDestinationId("0b7f4f0e-51a5-4c6e-8f0e-6a7d2c9b1e3f")
const PAGER = asDestinationId("1c8a5a1f-62b6-4d7f-9a1f-7b8e3d0c2f4a")

const definition = (overrides: Partial<CostBudgetDefinition> = {}): CostBudgetDefinition => ({
	name: "AWS production",
	enabled: true,
	amount: 1000,
	currency: "USD",
	period: "month",
	metric: "billed",
	filters: { provider: ["aws"] },
	alerts: [
		{ severity: "warning", percent: 100, basis: "forecast", destinationIds: [SLACK] },
		{ severity: "critical", percent: 100, basis: "actual", destinationIds: [PAGER] },
	],
	...overrides,
})

/** The row a budget reads back from, as the database returns the columns `fields` wrote. */
const storedRow = (
	fields: ReturnType<typeof costBudgetRuleFields>,
	overrides: Partial<CostBudgetRuleRow> = {},
): CostBudgetRuleRow => ({
	id: RULE_ID,
	name: fields.name,
	enabled: fields.enabled,
	costBudgetJson: fields.costBudgetJson,
	thresholdsJson: fields.thresholdsJson,
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_060_000,
	...overrides,
})

describe("costBudgetRuleFields", () => {
	it("is a managed cost_budget rule with a tier per alert at its percent", () => {
		expect(costBudgetRuleFields(definition())).toMatchObject({
			signalType: "cost_budget",
			comparator: "gte",
			severity: "critical",
			threshold: 100,
			destinationIdsJson: [SLACK, PAGER],
			thresholdsJson: [
				{ severity: "warning", value: 100, destinationIds: [SLACK] },
				{ severity: "critical", value: 100, destinationIds: [PAGER] },
			],
			costBudgetJson: {
				amount: 1000,
				currency: "USD",
				period: "month",
				metric: "billed",
				filters: { provider: ["aws"] },
				forecastSeverities: ["warning"],
			},
		})
	})

	it("orders the tiers lowest severity first, however the alerts were given", () => {
		const fields = costBudgetRuleFields(
			definition({
				alerts: [
					{ severity: "critical", percent: 120, basis: "actual", destinationIds: [] },
					{ severity: "warning", percent: 80, basis: "actual", destinationIds: [] },
				],
			}),
		)
		expect(Arr.map(fields.thresholdsJson, (tier) => [tier.severity, tier.value])).toEqual([
			["warning", 80],
			["critical", 120],
		])
		expect(fields.threshold).toBe(80)
	})
})

describe("costBudgetFromRow", () => {
	it("reads back the budget its fields were written from", () => {
		const budget = costBudgetFromRow(storedRow(costBudgetRuleFields(definition())))
		expect(Option.getOrThrow(budget)).toEqual({
			id: RULE_ID,
			...definition(),
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_060_000,
		})
	})

	// A guess shown in the form would be saved over what is stored.
	it("reads nothing when the stored budget or its tiers do not decode", () => {
		const fields = costBudgetRuleFields(definition())
		expect(costBudgetFromRow(storedRow(fields, { costBudgetJson: null }))).toEqual(Option.none())
		expect(costBudgetFromRow(storedRow(fields, { costBudgetJson: { amount: -1 } }))).toEqual(
			Option.none(),
		)
		expect(costBudgetFromRow(storedRow(fields, { thresholdsJson: [] }))).toEqual(Option.none())
	})
})

describe("evaluateCostBudget", () => {
	const fields = costBudgetRuleFields(definition())
	const check = (spent: number, now = "2026-11-16T00:00:00Z") =>
		evaluateCostBudget(
			fields.costBudgetJson,
			fields.thresholdsJson,
			costBudgetProgress(fields.costBudgetJson, Date.parse(now), [{ day: "2026-11-15", cost: spent }]),
		)

	it("is healthy while spend and forecast are under the budget", () => {
		expect(check(400)).toMatchObject({
			status: "healthy",
			value: 40,
			levels: [
				{ severity: "warning", status: "clear" },
				{ severity: "critical", status: "clear" },
			],
			reason: "Spent $400.00 of the $1,000.00 monthly budget (40%); forecast $800.00 by 2026-11-30",
		})
	})

	it("breaches the forecast tier alone, valued at the forecast's percent", () => {
		expect(check(600)).toMatchObject({
			status: "breached",
			value: 120,
			levels: [
				{ severity: "warning", status: "breach" },
				{ severity: "critical", status: "clear" },
			],
			reason: "Forecast to spend $1,200.00 of the $1,000.00 monthly budget (120%) by 2026-11-30; $600.00 spent so far",
		})
	})

	it("breaches both tiers once the money is spent, valued at the percent spent", () => {
		expect(check(1100)).toMatchObject({
			status: "breached",
			value: 110,
			levels: [
				{ severity: "warning", status: "breach" },
				{ severity: "critical", status: "breach" },
			],
			reason: "Spent $1,100.00 of the $1,000.00 monthly budget (110%); forecast $2,200.00 by 2026-11-30",
		})
	})

	it("holds the forecast tier, neither breached nor clear, just under its percent", () => {
		// 485 in fifteen days projects to 970: inside the band a forecast tier keeps its state in.
		expect(check(485)).toMatchObject({
			status: "healthy",
			levels: [
				{ severity: "warning", status: "hold" },
				{ severity: "critical", status: "clear" },
			],
		})
	})

	it("holds a forecast tier clear before a forecast exists", () => {
		const early = evaluateCostBudget(
			fields.costBudgetJson,
			fields.thresholdsJson,
			costBudgetProgress(fields.costBudgetJson, Date.parse("2026-11-02T00:00:00Z"), [
				{ day: "2026-11-01", cost: 900 },
			]),
		)
		expect(early).toMatchObject({
			status: "healthy",
			value: 90,
			reason: "Spent $900.00 of the $1,000.00 monthly budget (90%)",
		})
	})
})
