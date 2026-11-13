import { Result, Schema, Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { CostBucket } from "./anthropic-cost-api"
import { costBucket, costResult, FAKE_ORGANIZATION, type FakeCostBucket } from "./fake-anthropic"
import { toCostRows } from "./normalize"

const WINDOW = { startDay: "2026-11-01", endDay: "2026-11-10" }
/** The two newest days of a pull on 2026-11-11 can still change. */
const OPEN_DAY = "2026-11-09"

const normalize = (buckets: ReadonlyArray<FakeCostBucket>) =>
	toCostRows(Schema.decodeSync(Schema.Array(CostBucket))(buckets), FAKE_ORGANIZATION.id, WINDOW, OPEN_DAY)

const rowsOf = (buckets: ReadonlyArray<FakeCostBucket>) => Result.getOrThrow(normalize(buckets))

describe("toCostRows", () => {
	it("maps a model's token line, with its amount in cents as dollars", () => {
		expect(rowsOf([costBucket("2026-11-03", [costResult("123.45")])])).toEqual([
			{
				day: "2026-11-03",
				accountId: FAKE_ORGANIZATION.id,
				cloudService: "anthropic/claude-opus-5-5",
				serviceCategory: "AI and Machine Learning",
				usageType: "Claude Opus 5.5 Usage - Input Tokens",
				region: "global",
				resourceId: "wrkspc_01",
				resourceType: "workspace",
				serviceName: "",
				chargeCategory: "usage",
				basis: "billed",
				currency: "USD",
				billedCost: 1.2345,
				effectiveCost: 1.2345,
				listCost: 1.2345,
				consumedQuantity: 0,
				consumedUnit: "",
				tags: {
					service_tier: "standard",
					token_type: "uncached_input_tokens",
					context_window: "0-200k",
				},
				estimated: false,
			},
		])
	})

	it("names a line with no model by its cost type, else as Anthropic API with its description as the usage", () => {
		const tool = (costType: string | null, description: string | null) =>
			costResult("10", {
				model: null,
				cost_type: costType,
				description,
				token_type: null,
				service_tier: null,
				context_window: null,
			})
		const rows = rowsOf([
			costBucket("2026-11-03", [
				tool("web_search", "Web Search Usage"),
				tool("code_execution", "Code Execution Usage"),
				tool("session_usage", null),
				tool("something_new", "Priority Tier Commitment"),
				tool(null, null),
			]),
		])
		expect(Arr.map(rows, (row) => [row.cloudService, row.usageType, row.tags])).toEqual([
			["Web search", "Web Search Usage", {}],
			["Code execution", "Code Execution Usage", {}],
			["Managed Agents sessions", "session_usage", {}],
			["Anthropic API", "Priority Tier Commitment", {}],
			["Anthropic API", "", {}],
		])
	})

	it("puts the default workspace's lines on `default`, and a geography's on its region", () => {
		const rows = rowsOf([
			costBucket("2026-11-03", [
				costResult("100", { workspace_id: null }),
				costResult("100", { inference_geo: "us", currency: "usd" }),
			]),
		])
		expect(Arr.map(rows, (row) => [row.resourceId, row.region, row.currency])).toEqual([
			["default", "global", "USD"],
			["wrkspc_01", "us", "USD"],
		])
	})

	it("sums lines of one key, keeping only the tags they agree on", () => {
		const rows = rowsOf([
			costBucket("2026-11-03", [
				costResult("100", { service_tier: "standard" }),
				costResult("50", { service_tier: "batch" }),
				costResult("25", { workspace_id: "wrkspc_02" }),
			]),
		])
		expect(Arr.map(rows, (row) => [row.resourceId, row.billedCost, row.listCost, row.tags])).toEqual([
			["wrkspc_01", 1.5, 1.5, { token_type: "uncached_input_tokens", context_window: "0-200k" }],
			[
				"wrkspc_02",
				0.25,
				0.25,
				{ service_tier: "standard", token_type: "uncached_input_tokens", context_window: "0-200k" },
			],
		])
	})

	it("keeps only the window's days, and marks the days still being counted as estimated", () => {
		const rows = rowsOf([
			costBucket("2026-10-31", [costResult("100")]),
			costBucket("2026-11-01", [costResult("100")]),
			costBucket("2026-11-08", [costResult("100")]),
			costBucket("2026-11-09", []),
			costBucket("2026-11-10", [costResult("100")]),
			costBucket("2026-11-11", [costResult("100")]),
		])
		expect(Arr.map(rows, (row) => [row.day, row.estimated])).toEqual([
			["2026-11-01", false],
			["2026-11-08", false],
			["2026-11-10", true],
		])
	})

	it.each(["", "n/a", "Infinity"])("fails on the amount %j instead of dropping the line", (amount) => {
		expect(normalize([costBucket("2026-11-03", [costResult("100"), costResult(amount)])])).toEqual(
			Result.fail(amount),
		)
	})

	it("does not read an unreadable line outside the window", () => {
		expect(normalize([costBucket("2026-10-01", [costResult("n/a")])])).toEqual(Result.succeed([]))
	})
})
