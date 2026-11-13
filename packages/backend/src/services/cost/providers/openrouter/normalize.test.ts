import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Order } from "effect"
import type { ActivityItem } from "../../../org/openrouter-api"
import { toCostRows } from "./normalize"

const WINDOW = { startDay: "2026-11-01", endDay: "2026-11-03" }
const ACCOUNT = "user_account_a"
/** The newest completed day at pull time: its rows can still change. */
const OPEN_DAY = "2026-11-03"

const item = (overrides: Partial<ActivityItem>): ActivityItem => ({
	date: "2026-11-02",
	model: "anthropic/claude-sonnet-5",
	provider_name: "Anthropic",
	usage: 1.25,
	prompt_tokens: 1000,
	completion_tokens: 200,
	...overrides,
})

const rowsOf = (items: ReadonlyArray<ActivityItem>) => toCostRows(items, ACCOUNT, WINDOW, OPEN_DAY)

/** `day | service | usage type | billed | tokens` of each row, in a stable order. */
const summary = (items: ReadonlyArray<ActivityItem>) =>
	Arr.sort(
		Arr.map(rowsOf(items), (row) =>
			Arr.join(
				[row.day, row.cloudService, row.usageType, `${row.billedCost}`, `${row.consumedQuantity}`],
				" | ",
			),
		),
		Order.String,
	)

describe("toCostRows", () => {
	it("names the model as the service and the serving provider as the usage type", () => {
		const [row] = rowsOf([item({})])
		assert.deepStrictEqual(
			{
				day: row?.day,
				accountId: row?.accountId,
				cloudService: row?.cloudService,
				serviceCategory: row?.serviceCategory,
				usageType: row?.usageType,
				region: row?.region,
				chargeCategory: row?.chargeCategory,
				basis: row?.basis,
				currency: row?.currency,
				billedCost: row?.billedCost,
				effectiveCost: row?.effectiveCost,
				consumedQuantity: row?.consumedQuantity,
				consumedUnit: row?.consumedUnit,
			},
			{
				day: "2026-11-02",
				accountId: ACCOUNT,
				cloudService: "anthropic/claude-sonnet-5",
				serviceCategory: "AI and Machine Learning",
				usageType: "Anthropic",
				region: "global",
				chargeCategory: "usage",
				basis: "billed",
				currency: "USD",
				billedCost: 1.25,
				effectiveCost: 1.25,
				consumedQuantity: 1200,
				consumedUnit: "tokens",
			},
		)
	})

	it("sums a model's endpoints at one provider and keeps providers and days apart", () => {
		assert.deepStrictEqual(
			summary([
				item({ usage: 1, prompt_tokens: 10, completion_tokens: 5 }),
				item({ usage: 2, prompt_tokens: 20, completion_tokens: 5 }),
				item({ usage: 4, provider_name: "Amazon Bedrock", prompt_tokens: 1, completion_tokens: 1 }),
				item({ usage: 8, date: "2026-11-03", prompt_tokens: 2, completion_tokens: 2 }),
			]),
			[
				"2026-11-02 | anthropic/claude-sonnet-5 | Amazon Bedrock | 4 | 2",
				"2026-11-02 | anthropic/claude-sonnet-5 | Anthropic | 3 | 40",
				"2026-11-03 | anthropic/claude-sonnet-5 | Anthropic | 8 | 4",
			],
		)
	})

	it("leaves out days outside the window and rows OpenRouter billed nothing for", () => {
		assert.deepStrictEqual(
			summary([
				item({ date: "2026-10-31" }),
				item({ date: "2026-11-04" }),
				item({ model: "meta-llama/llama-4:free", usage: 0 }),
				item({ date: "2026-11-01", usage: 0.5, prompt_tokens: 1, completion_tokens: 1 }),
			]),
			["2026-11-01 | anthropic/claude-sonnet-5 | Anthropic | 0.5 | 2"],
		)
	})

	it("reads a timestamp at a day's midnight as that day", () => {
		assert.deepStrictEqual(summary([item({ date: "2026-11-02 00:00:00" })]), [
			"2026-11-02 | anthropic/claude-sonnet-5 | Anthropic | 1.25 | 1200",
		])
	})

	it("keeps a row whose provider or token counts OpenRouter left empty", () => {
		assert.deepStrictEqual(
			summary([item({ provider_name: null, prompt_tokens: null, completion_tokens: null })]),
			["2026-11-02 | anthropic/claude-sonnet-5 |  | 1.25 | 0"],
		)
	})

	it("marks the newest completed day as not final, and the days before it as final", () => {
		const rows = rowsOf([item({ date: "2026-11-02" }), item({ date: "2026-11-03" })])
		assert.deepStrictEqual(
			Arr.sort(
				Arr.map(rows, (row) => `${row.day} ${row.estimated}`),
				Order.String,
			),
			["2026-11-02 false", "2026-11-03 true"],
		)
	})
})
