import { Result, Schema, Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { toCostRows } from "./normalize"
import { CostBucket } from "./openai-costs-api"

const ACCOUNT = "org-GLHrIv00VVN9dEQC2b4wsBkf"
const WINDOW = { startDay: "2026-10-01", endDay: "2026-11-10" }
/** The two newest days of a pull on 2026-11-11 can still change. */
const OPEN_DAY = "2026-11-09"

const startOf = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000

/** A bucket as the API answers it, with the fields Maple does not read. */
const bucket = (day: string, results: ReadonlyArray<Record<string, unknown>>) => ({
	object: "bucket",
	start_time: startOf(day),
	end_time: startOf(day) + 86_400,
	results: Arr.map(results, (result) => ({
		object: "organization.costs.result",
		organization_id: ACCOUNT,
		...result,
	})),
})

const rows = (buckets: ReadonlyArray<unknown>) =>
	toCostRows(Schema.decodeUnknownSync(Schema.Array(CostBucket))(buckets), ACCOUNT, WINDOW, OPEN_DAY)

const okRows = (buckets: ReadonlyArray<unknown>) => {
	const result = rows(buckets)
	if (Result.isFailure(result)) return expect.fail(result.failure)
	return result.success
}

const charge = (lineItem: string | null, value: number, extra: Record<string, unknown> = {}) => ({
	amount: { value, currency: "usd" },
	line_item: lineItem,
	project_id: "proj_abc",
	...extra,
})

describe("toCostRows", () => {
	it("maps a recorded result: the model is the service, the line item the usage type", () => {
		expect(
			okRows([
				bucket("2026-10-03", [
					charge("gpt-4o-2024-08-06, input", 1.25, { quantity: 50_000, quantity_unit: "tokens" }),
				]),
			]),
		).toEqual([
			{
				day: "2026-10-03",
				accountId: ACCOUNT,
				cloudService: "openai/gpt-4o-2024-08-06",
				serviceCategory: "AI and Machine Learning",
				usageType: "gpt-4o-2024-08-06, input",
				region: "global",
				resourceId: "proj_abc",
				resourceType: "project",
				serviceName: "",
				chargeCategory: "usage",
				basis: "billed",
				currency: "USD",
				billedCost: 1.25,
				effectiveCost: 1.25,
				listCost: 1.25,
				consumedQuantity: 50_000,
				consumedUnit: "tokens",
				tags: {},
				estimated: false,
			},
		])
	})

	it("names the service after the model, the product, or nothing when the line item is missing", () => {
		const mapped = okRows([
			bucket("2026-10-03", [
				charge("ft-gpt-4o-2024-08-06, input", 1),
				// Seen live: a modality between the model and the part.
				charge("gpt-realtime-2 audio, cached input", 4),
				charge("assistants api | file search", 2),
				charge(null, 3, { project_id: null }),
			]),
		])
		expect(
			Arr.map(mapped, (row) => [row.cloudService, row.usageType, row.resourceId, row.resourceType]),
		).toEqual([
			["openai/ft-gpt-4o-2024-08-06", "ft-gpt-4o-2024-08-06, input", "proj_abc", "project"],
			["openai/gpt-realtime-2", "gpt-realtime-2 audio, cached input", "proj_abc", "project"],
			["openai/assistants api | file search", "assistants api | file search", "proj_abc", "project"],
			["openai/unattributed", "", "", ""],
		])
	})

	it("merges results of one key, adding quantities only in the row's own unit", () => {
		const mapped = okRows([
			bucket("2026-10-03", [
				charge("gpt-4o, input", 1, { quantity: 100, quantity_unit: "tokens" }),
				charge("gpt-4o, input", 2, { quantity: 50, quantity_unit: "tokens" }),
				charge("gpt-4o, input", 0.5, { quantity: 7, quantity_unit: "requests" }),
				// Another project is another resource, so another row.
				charge("gpt-4o, input", 4, { project_id: "proj_other" }),
			]),
		])
		expect(
			Arr.map(mapped, (row) => [
				row.resourceId,
				row.billedCost,
				row.consumedQuantity,
				row.consumedUnit,
			]),
		).toEqual([
			["proj_abc", 3.5, 150, "tokens"],
			["proj_other", 4, 0, ""],
		])
	})

	it("keeps only the window's days, and marks the days from the open day on as estimated", () => {
		const mapped = okRows([
			bucket("2026-09-30", [charge("gpt-4o, input", 9)]),
			bucket("2026-10-01", [charge("gpt-4o, input", 1)]),
			bucket("2026-11-08", [charge("gpt-4o, input", 2)]),
			bucket("2026-11-09", [charge("gpt-4o, input", 3)]),
			bucket("2026-11-10", [charge("gpt-4o, input", 4)]),
			bucket("2026-11-11", [charge("gpt-4o, input", 9)]),
		])
		expect(Arr.map(mapped, (row) => [row.day, row.billedCost, row.estimated])).toEqual([
			["2026-10-01", 1, false],
			["2026-11-08", 2, false],
			["2026-11-09", 3, true],
			["2026-11-10", 4, true],
		])
	})

	it("skips results without an amount, and reads a missing currency as US dollars", () => {
		const mapped = okRows([
			bucket("2026-10-03", [
				{ line_item: "gpt-4o, input", project_id: null },
				{ amount: {}, line_item: "gpt-4o, output", project_id: null },
				{ amount: { value: 2 }, line_item: "gpt-4o, cached", project_id: null },
				{ amount: { value: 1, currency: "eur" }, line_item: "gpt-4o, batch", project_id: null },
			]),
		])
		expect(Arr.map(mapped, (row) => [row.usageType, row.currency])).toEqual([
			["gpt-4o, cached", "USD"],
			["gpt-4o, batch", "EUR"],
		])
	})

	it("fails an amount that is not a finite number instead of storing it", () => {
		const result = rows([
			bucket("2026-10-03", [
				charge("gpt-4o, input", 1),
				charge("gpt-4o, output", Number.POSITIVE_INFINITY),
			]),
		])
		expect(Result.isFailure(result)).toBe(true)
	})
})
