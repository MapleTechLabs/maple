import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Order, Schema } from "effect"
import type { CostPullRow } from "../../CostProvider"
import { Invoice, InvoiceLineItem } from "./invoices-api"
import { chargedDays, invoicePeriod, spreadEvenly, toCostRows } from "./normalize"

const ORGANIZATION = "acme"

const invoice = (month: string, nextMonth: string, paid = true) =>
	Schema.decodeSync(Invoice)({
		id: `inv_${month}`,
		billing_period_start: `${month}-01T00:00:00.000Z`,
		billing_period_end: `${nextMonth}-01T00:00:00.000Z`,
		paid,
	})

const OCTOBER = invoice("2026-10", "2026-11")
const NOVEMBER = invoice("2026-11", "2026-12", false)
const OCTOBER_DAYS = { startDay: "2026-10-01", endDay: "2026-10-31" }

const line = (overrides: Partial<typeof InvoiceLineItem.Encoded>) =>
	Schema.decodeSync(InvoiceLineItem)({
		id: "line_1",
		description: "PS-10-AWS-ARM for branch 'main'",
		metric_name: "PS_10_AWS_ARM",
		subtotal: "31.00",
		database_name: "orders",
		resource: {
			type: "Branch",
			name: "main",
			created_at: "2025-03-04T10:00:00.000Z",
			deleted_at: null,
		},
		...overrides,
	})

const branch = (name: string, created_at: string, deleted_at: string | null = null) => ({
	type: "Branch",
	name,
	created_at,
	deleted_at,
})

const byDay = Order.mapInput(Order.String, (row: CostPullRow) => row.day)

const total = (rows: ReadonlyArray<CostPullRow>) => Arr.reduce(rows, 0, (sum, row) => sum + row.billedCost)

/** `day | database | branch | SKU | billed` of each row, in a stable order, to the cent. */
const summary = (rows: ReadonlyArray<CostPullRow>) =>
	Arr.sort(
		Arr.map(rows, (row) =>
			Arr.join(
				[row.day, row.cloudService, row.resourceId, row.usageType, row.billedCost.toFixed(2)],
				" | ",
			),
		),
		Order.String,
	)

describe("invoicePeriod", () => {
	it("ends on the day before the next period starts", () => {
		assert.deepStrictEqual(invoicePeriod(OCTOBER), OCTOBER_DAYS)
		assert.deepStrictEqual(invoicePeriod(invoice("2026-02", "2026-03")), {
			startDay: "2026-02-01",
			endDay: "2026-02-28",
		})
	})
})

describe("spreadEvenly", () => {
	it("adds up to the amount, with the last day taking the remainder", () => {
		const shares = spreadEvenly(100, chargedDays(OCTOBER_DAYS, undefined))
		assert.strictEqual(shares.length, 31)
		assert.strictEqual(
			Arr.reduce(shares, 0, (sum, share) => sum + share.amount),
			100,
		)
		assert.strictEqual(shares[0]?.amount, 100 / 31)
	})

	it("gives a single day the whole amount", () => {
		assert.deepStrictEqual(spreadEvenly(12.5, ["2026-10-07"]), [{ day: "2026-10-07", amount: 12.5 }])
	})
})

describe("chargedDays", () => {
	it("is the whole period for a branch older than it, a line with no branch, or dates outside it", () => {
		const whole = chargedDays(OCTOBER_DAYS, undefined)
		assert.strictEqual(whole.length, 31)
		assert.deepStrictEqual(chargedDays(OCTOBER_DAYS, line({}).resource), whole)
		assert.deepStrictEqual(chargedDays(OCTOBER_DAYS, null), whole)
		// Deleted before the period began: the dates give no day in it.
		assert.deepStrictEqual(
			chargedDays(
				OCTOBER_DAYS,
				line({ resource: branch("old", "2026-01-05T00:00:00Z", "2026-09-20T00:00:00Z") }).resource,
			),
			whole,
		)
	})

	it("starts on the day the branch was made and ends on the day it was deleted", () => {
		const days = chargedDays(
			OCTOBER_DAYS,
			line({ resource: branch("preview", "2026-10-10T18:30:00Z", "2026-10-12T02:00:00Z") }).resource,
		)
		assert.deepStrictEqual(days, ["2026-10-10", "2026-10-11", "2026-10-12"])
	})
})

describe("toCostRows", () => {
	it("names the database as the service, the SKU as the usage type and the branch as the resource", () => {
		const [row] = toCostRows([{ invoice: OCTOBER, lineItems: [line({})] }], ORGANIZATION, {
			startDay: "2026-10-01",
			endDay: "2026-10-01",
		})
		assert.deepStrictEqual(row, {
			day: "2026-10-01",
			accountId: ORGANIZATION,
			cloudService: "orders",
			serviceCategory: "Databases",
			usageType: "PS_10_AWS_ARM",
			region: "global",
			resourceId: "main",
			resourceType: "branch",
			serviceName: "",
			chargeCategory: "usage",
			basis: "billed",
			currency: "USD",
			billedCost: 1,
			effectiveCost: 1,
			listCost: 1,
			consumedQuantity: 0,
			consumedUnit: "",
			tags: {},
			estimated: false,
		})
	})

	it("spreads a closed month so its days add up to the invoice's line items", () => {
		const lineItems = [
			line({ subtotal: "39.00" }),
			line({
				id: "line_2",
				metric_name: "egress",
				description: "Egress for branch 'main'",
				subtotal: "0.37",
			}),
			line({
				id: "line_3",
				database_name: "search",
				metric_name: "M1_20_AWS_ARM_D_METAL_10",
				subtotal: "529.13",
			}),
		]
		const rows = toCostRows([{ invoice: OCTOBER, lineItems }], ORGANIZATION, OCTOBER_DAYS)
		// One row per day and line: 31 days of three lines.
		assert.strictEqual(rows.length, 93)
		assert.closeTo(total(rows), 39 + 0.37 + 529.13, 1e-9)
		assert.isTrue(Arr.every(rows, (row) => !row.estimated))
	})

	it("nets a deleted branch's prorated discount into the days it existed", () => {
		const resource = branch("preview", "2026-10-06T09:00:00Z", "2026-10-15T16:00:00Z")
		const rows = toCostRows(
			[
				{
					invoice: OCTOBER,
					lineItems: [
						line({ subtotal: "31.00", resource }),
						line({
							id: "line_2",
							description: "Prorated PS-10-AWS-ARM discount for branch 'preview'",
							subtotal: "-21.00",
							resource,
						}),
					],
				},
			],
			ORGANIZATION,
			OCTOBER_DAYS,
		)
		// Ten days, the 6th through the 15th, of what the branch cost: 31 less 21.
		assert.deepStrictEqual(
			summary(rows),
			Arr.map(
				["06", "07", "08", "09", "10", "11", "12", "13", "14", "15"],
				(day) => `2026-10-${day} | orders | preview | PS_10_AWS_ARM | 1.00`,
			),
		)
		assert.closeTo(total(rows), 10, 1e-9)
	})

	it("starts a branch made mid-month on the day it was made", () => {
		const rows = toCostRows(
			[
				{
					invoice: OCTOBER,
					lineItems: [
						line({ subtotal: "22.00", resource: branch("staging", "2026-10-21T23:59:00Z") }),
					],
				},
			],
			ORGANIZATION,
			OCTOBER_DAYS,
		)
		assert.strictEqual(rows.length, 11)
		assert.deepStrictEqual(Arr.take(summary(rows), 1), [
			"2026-10-21 | orders | staging | PS_10_AWS_ARM | 2.00",
		])
		assert.closeTo(total(rows), 22, 1e-9)
	})

	it("shows the open month's days so far as not final, each a share of the whole month's line", () => {
		const rows = toCostRows(
			[{ invoice: NOVEMBER, lineItems: [line({ subtotal: "30.00" })] }],
			ORGANIZATION,
			{ startDay: "2026-11-01", endDay: "2026-11-12" },
		)
		assert.strictEqual(rows.length, 12)
		assert.isTrue(Arr.every(rows, (row) => row.estimated && row.billedCost === 1))
	})

	it("takes each day of a window that crosses two invoices from the invoice that bills it", () => {
		const rows = toCostRows(
			[
				{ invoice: NOVEMBER, lineItems: [line({ subtotal: "60.00" })] },
				{ invoice: OCTOBER, lineItems: [line({ subtotal: "31.00" })] },
			],
			ORGANIZATION,
			{ startDay: "2026-10-30", endDay: "2026-11-02" },
		)
		assert.deepStrictEqual(
			Arr.map(Arr.sort(rows, byDay), (row) => `${row.day} ${row.billedCost} ${row.estimated}`),
			["2026-10-30 1 false", "2026-10-31 1 false", "2026-11-01 2 true", "2026-11-02 2 true"],
		)
	})

	it("keeps databases, branches and SKUs apart and sums lines that share all three", () => {
		const rows = toCostRows(
			[
				{
					invoice: OCTOBER,
					lineItems: [
						line({ subtotal: "31.00" }),
						line({ id: "line_2", subtotal: "62.00" }),
						line({ id: "line_3", subtotal: "3.10", metric_name: "egress" }),
						line({ id: "line_4", subtotal: "6.20", database_name: "search" }),
						line({
							id: "line_5",
							subtotal: "9.30",
							resource: branch("dev", "2026-01-01T00:00:00Z"),
						}),
					],
				},
			],
			ORGANIZATION,
			{ startDay: "2026-10-02", endDay: "2026-10-02" },
		)
		assert.deepStrictEqual(summary(rows), [
			"2026-10-02 | orders | dev | PS_10_AWS_ARM | 0.30",
			"2026-10-02 | orders | main | PS_10_AWS_ARM | 3.00",
			"2026-10-02 | orders | main | egress | 0.10",
			"2026-10-02 | search | main | PS_10_AWS_ARM | 0.20",
		])
	})

	it("leaves out a line of zero, and files a line with no database or branch under its description", () => {
		const rows = toCostRows(
			[
				{
					invoice: OCTOBER,
					lineItems: [
						line({ subtotal: "0.00", metric_name: "egress" }),
						line({
							id: "line_2",
							description: "Support plan",
							metric_name: "support",
							subtotal: "310",
							database_name: null,
							resource: null,
						}),
					],
				},
			],
			ORGANIZATION,
			{ startDay: "2026-10-31", endDay: "2026-10-31" },
		)
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.cloudService, row.usageType, row.resourceId, row.resourceType]),
			[["Support plan", "support", "", ""]],
		)
		assert.closeTo(total(rows), 10, 1e-9)
	})
})
