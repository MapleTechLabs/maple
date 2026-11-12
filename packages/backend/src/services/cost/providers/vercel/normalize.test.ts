import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Order } from "effect"
import type { VercelCharge } from "../../../integrations/vercel/api"
import { toCostRows } from "./normalize"

const WINDOW = { startDay: "2026-11-01", endDay: "2026-11-04" }
const ACCOUNT = "acme"
/** Yesterday at pull time: it and today can still change. */
const OPEN_DAY = "2026-11-03"

const charge = (overrides: Partial<VercelCharge> = {}): VercelCharge => ({
	BilledCost: 1.5,
	BillingCurrency: "USD",
	ChargeCategory: "Usage",
	ChargePeriodStart: "2026-11-02T00:00:00.000Z",
	ConsumedQuantity: 300,
	ConsumedUnit: "GB-Hours",
	EffectiveCost: 1.5,
	RegionId: "iad1",
	ServiceCategory: "Compute",
	ServiceName: "Function Duration",
	SkuId: "function-duration",
	Tags: { ProjectId: "prj_web", ProjectName: "web" },
	...overrides,
})

const rowsOf = (charges: ReadonlyArray<VercelCharge>) => toCostRows(charges, ACCOUNT, WINDOW, OPEN_DAY)

/** `day | service | SKU | project | region | kind | billed | quantity` of each row, in a stable order. */
const summary = (charges: ReadonlyArray<VercelCharge>) =>
	Arr.sort(
		Arr.map(rowsOf(charges), (row) =>
			Arr.join(
				[
					row.day,
					row.cloudService,
					row.usageType,
					row.resourceId,
					row.region,
					row.chargeCategory,
					`${row.billedCost}`,
					`${row.consumedQuantity}`,
				],
				" | ",
			),
		),
		Order.String,
	)

describe("toCostRows", () => {
	it("names the product as the service, its SKU as the usage type and the project as the resource", () => {
		assert.deepStrictEqual(rowsOf([charge()]), [
			{
				day: "2026-11-02",
				accountId: "acme",
				cloudService: "Function Duration",
				serviceCategory: "Compute",
				usageType: "function-duration",
				region: "iad1",
				resourceId: "web",
				resourceType: "project",
				serviceName: "",
				chargeCategory: "usage",
				basis: "billed",
				currency: "USD",
				billedCost: 1.5,
				effectiveCost: 1.5,
				// Vercel reports no list price.
				listCost: 1.5,
				consumedQuantity: 300,
				consumedUnit: "GB-Hours",
				tags: {},
				estimated: false,
			},
		])
	})

	it("reads a charge that carries only the three fields Vercel must send", () => {
		const [row] = rowsOf([
			{ BilledCost: 20, ChargePeriodStart: "2026-11-01T00:00:00Z", ServiceName: "Pro Plan" },
		])
		assert.deepStrictEqual(
			[
				row?.usageType,
				row?.serviceCategory,
				row?.region,
				row?.resourceId,
				row?.resourceType,
				row?.chargeCategory,
				row?.currency,
				row?.effectiveCost,
				row?.consumedQuantity,
				row?.consumedUnit,
			],
			["", "Other", "global", "", "", "unknown", "USD", 20, 0, ""],
		)
	})

	it("treats a null field like a missing one, and a SKU named like its product as no usage type", () => {
		const [row] = rowsOf([
			charge({
				SkuId: "Function Duration",
				RegionId: null,
				ServiceCategory: null,
				ConsumedQuantity: null,
				ConsumedUnit: null,
				EffectiveCost: null,
				BillingCurrency: null,
				Tags: null,
			}),
		])
		assert.deepStrictEqual(
			[row?.usageType, row?.region, row?.serviceCategory, row?.resourceId, row?.effectiveCost],
			["", "global", "Other", "", 1.5],
		)
	})

	it("falls back to the project's id when Vercel sends no name", () => {
		const [row] = rowsOf([charge({ Tags: { ProjectId: "prj_web" } })])
		assert.deepStrictEqual([row?.resourceId, row?.resourceType], ["prj_web", "project"])
	})

	it("maps each FOCUS charge category, and one it does not know to unknown", () => {
		const categories = ["Usage", "Purchase", "Credit", "Tax", "Adjustment", "Refund"]
		const rows = rowsOf(
			Arr.map(categories, (ChargeCategory) => charge({ ChargeCategory, SkuId: ChargeCategory })),
		)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => row.chargeCategory),
			["usage", "purchase", "credit", "tax", "adjustment", "unknown"],
		)
	})

	it("sums lines that share day, product, SKU, project and region, and keeps the others apart", () => {
		assert.deepStrictEqual(
			summary([
				charge({ BilledCost: 1, ConsumedQuantity: 100 }),
				charge({ BilledCost: 2.5, ConsumedQuantity: 250 }),
				charge({ BilledCost: 4, RegionId: "fra1" }),
				charge({ BilledCost: 8, Tags: { ProjectId: "prj_api", ProjectName: "api" } }),
				charge({ BilledCost: 16, ChargePeriodStart: "2026-11-01T00:00:00.000Z" }),
				charge({ BilledCost: 32, SkuId: "function-invocations" }),
			]),
			[
				"2026-11-01 | Function Duration | function-duration | web | iad1 | usage | 16 | 300",
				"2026-11-02 | Function Duration | function-duration | api | iad1 | usage | 8 | 300",
				"2026-11-02 | Function Duration | function-duration | web | fra1 | usage | 4 | 300",
				"2026-11-02 | Function Duration | function-duration | web | iad1 | usage | 3.5 | 350",
				"2026-11-02 | Function Duration | function-invocations | web | iad1 | usage | 32 | 300",
			],
		)
	})

	it("keeps a credit as its own negative row beside the usage it offsets", () => {
		assert.deepStrictEqual(
			summary([
				charge({ BilledCost: 5 }),
				charge({ BilledCost: -5, ChargeCategory: "Credit", ConsumedQuantity: null }),
			]),
			[
				"2026-11-02 | Function Duration | function-duration | web | iad1 | credit | -5 | 0",
				"2026-11-02 | Function Duration | function-duration | web | iad1 | usage | 5 | 300",
			],
		)
	})

	it("leaves out what Vercel billed nothing for, but not a charge with an effective cost only", () => {
		const rows = rowsOf([
			charge({ BilledCost: 0, EffectiveCost: 0, SkuId: "included" }),
			charge({ BilledCost: 0, EffectiveCost: 0.75, SkuId: "committed" }),
			// Two lines of one key that cancel out are nothing billed either.
			charge({ BilledCost: 2, EffectiveCost: 2, SkuId: "reversed" }),
			charge({ BilledCost: -2, EffectiveCost: -2, SkuId: "reversed" }),
		])
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.usageType, row.billedCost, row.effectiveCost]),
			[["committed", 0, 0.75]],
		)
	})

	it("marks yesterday and today as still open to change", () => {
		const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]
		const rows = rowsOf(Arr.map(days, (day) => charge({ ChargePeriodStart: `${day}T00:00:00.000Z` })))
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.day, row.estimated]),
			[
				["2026-11-01", false],
				["2026-11-02", false],
				["2026-11-03", true],
				["2026-11-04", true],
			],
		)
	})

	it("drops a charge of a day outside the window", () => {
		assert.deepStrictEqual(
			summary([
				charge({ ChargePeriodStart: "2026-10-31T00:00:00.000Z" }),
				charge({ ChargePeriodStart: "2026-11-05T00:00:00.000Z" }),
			]),
			[],
		)
	})
})
