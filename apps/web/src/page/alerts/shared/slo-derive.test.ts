import { SLO_BURN_TIERS } from "@maple/domain/slo"
import { Array as Arr, Option } from "effect"
import { describe, expect, test } from "vitest"
import {
	budgetLeft,
	budgetNotice,
	budgetToneOf,
	burnTone,
	holdReason,
	isBurning,
	isSpent,
	openBudgetIncident,
	openBurnIncident,
	tierStates,
} from "./slo-derive"
import { budgetIncidentRow, burnIncidentRow, checkoutSlo, lowTargetSlo, sloStatus } from "./slo-test-fixtures"

const idOf = Option.map((row: { readonly id: string }) => row.id)

describe("burnTone", () => {
	test("a burn is red at the SLO's own critical factor and amber at its lowest warning factor", () => {
		const slo = checkoutSlo()
		expect(Arr.map([2.9, 3, 6, 14.3, 14.4], (rate) => burnTone(slo, rate))).toEqual([
			"neutral",
			"warn",
			"warn",
			"warn",
			"crit",
		])
	})

	test("a 90% target is red from 8x, the burn its page tier really fires at", () => {
		const slo = lowTargetSlo()
		expect(Arr.map([2.9, 3, 7.9, 8.1, 10], (rate) => burnTone(slo, rate))).toEqual([
			"neutral",
			"warn",
			"warn",
			"crit",
			"crit",
		])
	})
})

describe("tier readings", () => {
	test("only the slow tier breaches on a day-long 3x burn", () => {
		expect(Arr.map(tierStates(checkoutSlo(), sloStatus("slow")), (reading) => reading.state)).toEqual([
			"clear",
			"clear",
			"breach",
		])
	})

	test("a hold says whether the short window is empty or the tier has too few events to judge", () => {
		const reasons = (scenario: "holding" | "sparse" | "no-data") =>
			Arr.map(SLO_BURN_TIERS, (tier) => holdReason(sloStatus(scenario), tier))
		// An outage empties 5m and 30m; the slow tier's 2h window still holds events.
		expect(reasons("holding")).toEqual(["no-events", "no-events", "few-events"])
		expect(reasons("sparse")).toEqual(["few-events", "few-events", "few-events"])
		expect(reasons("no-data")).toEqual(["no-events", "no-events", "no-events"])
	})
})

describe("an SLO's two incidents", () => {
	const slo = checkoutSlo()
	const burn = burnIncidentRow()
	const budget = budgetIncidentRow()

	test("the burn and the budget incident are told apart whichever synced first", () => {
		expect(Option.getOrNull(idOf(openBurnIncident(slo, [budget, burn])))).toBe(burn.id)
		expect(Option.getOrNull(idOf(openBudgetIncident(slo, [burn, budget])))).toBe(budget.id)
		expect(Option.isNone(openBurnIncident(slo, [budget]))).toBe(true)
		expect(Option.isNone(openBudgetIncident(slo, [burn]))).toBe(true)
	})

	test("a resolved or another rule's incident is neither", () => {
		const resolved = { ...budget, status: "resolved" }
		const other = budgetIncidentRow({ rule_id: lowTargetSlo().alert_rule_id ?? "" })
		expect(Option.isNone(openBudgetIncident(slo, [resolved, other]))).toBe(true)
	})

	test("a held tier counts as burning only while the burn incident is open", () => {
		const row = { slo, status: sloStatus("holding") }
		expect([isBurning(row, []), isBurning(row, [budget]), isBurning(row, [burn])]).toEqual([
			false,
			false,
			true,
		])
	})
})

describe("the budget's reading", () => {
	test("no events leave no budget to read, and nothing spent", () => {
		const status = sloStatus("no-data")
		expect(budgetLeft(status)).toBeNull()
		expect(isSpent(checkoutSlo(), status)).toBe(false)
	})

	test("a budget overspent on one failed request is not judged spent", () => {
		const slo = checkoutSlo()
		const sparse = sloStatus("sparse")
		expect(sparse.budget_remaining).toBeLessThan(0)
		expect([isSpent(slo, sparse), budgetToneOf(slo, sparse)]).toEqual([false, "neutral"])
		const exhausted = sloStatus("exhausted")
		expect([isSpent(slo, exhausted), budgetToneOf(slo, exhausted)]).toEqual([true, "crit"])
	})

	test("the notice promises a resolve only once the budget is back past the incident's margin", () => {
		const slo = checkoutSlo()
		const titleAt = (budget: number) => budgetNotice(slo, { budget_remaining: budget }).title
		expect([titleAt(-0.35), titleAt(0), titleAt(0.01), titleAt(0.02), titleAt(0.4)]).toEqual([
			"Error budget spent",
			"Error budget spent",
			"Error budget barely back",
			"Error budget is back",
			"Error budget is back",
		])
		expect(budgetNotice(slo, { budget_remaining: 0.01 }).description).toContain("stays open until 2%")
	})

	test("heavy sampling does not turn a few recorded spans into a spent budget", () => {
		const slo = checkoutSlo()
		// Weighted, the window reads as 1.24M events; only eight spans were recorded.
		const sampled = { ...sloStatus("exhausted"), sample_count: 8 }
		expect([isSpent(slo, sampled), budgetToneOf(slo, sampled)]).toEqual([false, "neutral"])
	})
})
