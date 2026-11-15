import { costBudgetProgress } from "@maple/domain/cost-budget"
import {
	AlertDestinationId,
	AlertRuleId,
	type CostBudget,
	type CostBudgetListResponse,
	type CostBudgetStatus,
} from "@maple/domain/http"
import type { AlertDestinationRow } from "@maple/web-data/collections/alerts"
import { Array as Arr, DateTime, Schema, String as Str } from "effect"
import { perDimension } from "../page/cost/derive"
import type { FormOptions } from "../page/cost/budget-form/model"

// Cost budgets for the Cost lab and scene tests: the shapes the list has to draw (on track, over
// on the forecast, over on the spend, switched off, one that notifies nobody, a narrow slice).

const DAY = 86_400_000

const ruleId = Schema.decodeSync(AlertRuleId)
const destinationId = Schema.decodeSync(AlertDestinationId)

export const FINANCE_CHANNEL_ID = destinationId("0199c001-0000-7000-8000-000000000001")
const PLATFORM_ON_CALL_ID = destinationId("0199c001-0000-7000-8000-000000000002")

/** The org's alert destinations, as the live sync delivers them. */
export const budgetDestinationsOf = (orgId: string, nowMs: number): ReadonlyArray<AlertDestinationRow> =>
	Arr.map(
		[
			{ id: FINANCE_CHANNEL_ID, name: "#finance", type: "slack" },
			{ id: PLATFORM_ON_CALL_ID, name: "Platform on-call", type: "pagerduty" },
		],
		(destination) => ({
			...destination,
			org_id: orgId,
			enabled: true,
			config_json: { summary: destination.name, channelLabel: null },
			last_tested_at: null,
			last_test_error: null,
			disabled_at: null,
			disabled_reason: null,
			created_at: new Date(nowMs - 30 * DAY).toISOString(),
			updated_at: new Date(nowMs - 30 * DAY).toISOString(),
		}),
	)

type Seed = Pick<CostBudget, "name" | "amount" | "period" | "filters" | "alerts"> &
	Partial<Pick<CostBudget, "enabled" | "currency">> &
	Readonly<{
		/** What the budget's slice has cost in its current period, booked on the day before now. */
		spent: number
	}>

const SEEDS: ReadonlyArray<Seed> = [
	{
		name: "All cloud spend",
		amount: 12_000,
		period: "month",
		filters: {},
		spent: 4_180.42,
		alerts: [
			{ severity: "warning", percent: 100, basis: "forecast", destinationIds: [FINANCE_CHANNEL_ID] },
			{ severity: "critical", percent: 100, basis: "actual", destinationIds: [PLATFORM_ON_CALL_ID] },
		],
	},
	{
		name: "AWS production",
		amount: 6_000,
		period: "month",
		filters: { provider: ["aws"], account: ["123456789012"] },
		spent: 3_912.07,
		alerts: [
			{ severity: "warning", percent: 100, basis: "forecast", destinationIds: [FINANCE_CHANNEL_ID] },
			{ severity: "critical", percent: 100, basis: "actual", destinationIds: [PLATFORM_ON_CALL_ID] },
		],
	},
	{
		name: "Model spend",
		amount: 1_500,
		period: "month",
		filters: { provider: ["openrouter", "anthropic"] },
		spent: 1_734.9,
		alerts: [
			{ severity: "warning", percent: 80, basis: "actual", destinationIds: [FINANCE_CHANNEL_ID] },
			{ severity: "critical", percent: 100, basis: "actual", destinationIds: [FINANCE_CHANNEL_ID] },
		],
	},
	{
		name: "Edge and CDN, EU",
		amount: 900,
		currency: "EUR",
		period: "quarter",
		filters: { provider: ["cloudflare"], region: ["eu-central-1", "eu-west-1"] },
		spent: 211.3,
		alerts: [{ severity: "warning", percent: 90, basis: "actual", destinationIds: [] }],
	},
	{
		name: "Data warehouse",
		amount: 30_000,
		period: "year",
		filters: { cloud_service: ["Amazon Redshift"] },
		spent: 26_400,
		enabled: false,
		alerts: [
			{ severity: "critical", percent: 100, basis: "actual", destinationIds: [PLATFORM_ON_CALL_ID] },
		],
	},
]

const day = (epochMs: number): string => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(epochMs))

/** The seeded budgets as the API lists them at `nowMs`: newest first, each with where it stands. */
export const budgetsOf = (nowMs: number): CostBudgetListResponse => ({
	budgets: Arr.map(SEEDS, (seed, index): CostBudgetStatus => {
		const { spent, ...budget } = seed
		return {
			id: ruleId(`0199c000-0000-7000-8000-${Str.padStart(12, "0")(String(index + 1))}`),
			enabled: true,
			currency: "USD",
			metric: "billed",
			...budget,
			createdAt: nowMs - (index + 2) * DAY,
			updatedAt: nowMs - (index + 1) * DAY,
			progress: costBudgetProgress(budget, nowMs, [{ day: day(nowMs - DAY), cost: spent }]),
		}
	}),
})

export const noBudgets: CostBudgetListResponse = { budgets: [] }

const row = (key: string, cost: number) => ({ key, cost, previousCost: cost })

/** What the editor offers to pick from: two billing currencies and each dimension's largest values. */
export const budgetFormOptions: FormOptions = {
	currency: "USD",
	currencies: ["USD", "EUR"],
	sources: [],
	facets: {
		...perDimension(() => []),
		provider: [row("aws", 5_210), row("openrouter", 1_120), row("cloudflare", 640), row("vercel", 310)],
		cloud_service: [
			row("Amazon Elastic Compute Cloud - Compute", 2_840),
			row("Amazon Relational Database Service", 1_260),
			row("Amazon Simple Storage Service", 520),
			row("AWS Lambda", 190),
		],
		service_category: [
			row("Compute", 3_400),
			row("Databases", 1_500),
			row("AI and Machine Learning", 1_120),
		],
		region: [row("us-east-1", 3_900), row("eu-central-1", 1_100), row("global", 640)],
		account: [row("123456789012", 5_210)],
	},
}
