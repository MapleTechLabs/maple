import { Schema, Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { Subscription, UsageRow } from "./cloudflare-billing-api"
import { FAKE_ACCOUNT, type FakeSubscription, usageRow } from "./fake-cloudflare"
import { toSubscriptionRows, toUsageRows } from "./normalize"

const ACCOUNT = FAKE_ACCOUNT.id
const WINDOW = { startDay: "2026-10-01", endDay: "2026-11-10" }
/** The two newest days of a pull on 2026-11-11 can still change. */
const OPEN_DAY = "2026-11-09"

const usage = (rows: ReadonlyArray<typeof UsageRow.Encoded>) =>
	toUsageRows(Schema.decodeSync(Schema.Array(UsageRow))(rows), ACCOUNT, WINDOW, OPEN_DAY)

const fees = (subscriptions: ReadonlyArray<FakeSubscription>, window = WINDOW) =>
	toSubscriptionRows(
		Schema.decodeSync(Schema.Array(Subscription))(subscriptions),
		ACCOUNT,
		window,
		OPEN_DAY,
	)

/** A row as the API answers it, with the fields Maple does not read. */
const recorded = {
	ServiceName: "Durable Objects Compute Duration (First 400,000 GB-s are included)",
	ServiceFamilyName: "Durable Objects",
	ChargeCategory: "Usage",
	ChargeClass: null,
	ChargeDescription: "Durable Objects Compute Duration",
	ChargePeriodStart: "2026-10-03T00:00:00Z",
	ChargePeriodEnd: "2026-10-04T00:00:00Z",
	BillingPeriodStart: "2026-10-01T00:00:00Z",
	BillingCurrency: "USD",
	ConsumedUnit: "GB-seconds",
	ConsumedQuantity: 120000.5,
	PricingQuantity: 120000.5,
	PricingUnit: "GB-seconds",
	CumulatedPricingQuantity: 610000,
	ListCost: 1.5,
	ContractedCost: 1.5,
	EffectiveCost: 1.25,
	BilledCost: 1.25,
	CumulatedContractedCost: 2.6,
	SubscriptionId: "sub_example",
	BillingAccountId: ACCOUNT,
	BillingAccountName: "Example Account",
	ServiceProviderName: "Cloudflare, Inc.",
	InvoiceIssuerName: "Cloudflare, Inc.",
	HostProviderName: "Cloudflare, Inc.",
}

describe("toUsageRows", () => {
	it("maps a recorded row: the product is the service, the priced metric the usage type", () => {
		expect(usage([recorded])).toEqual([
			{
				day: "2026-10-03",
				accountId: ACCOUNT,
				cloudService: "Durable Objects",
				serviceCategory: "Compute",
				usageType: "Durable Objects Compute Duration (First 400,000 GB-s are included)",
				region: "global",
				resourceId: "",
				resourceType: "",
				serviceName: "",
				chargeCategory: "usage",
				basis: "billed",
				currency: "USD",
				billedCost: 1.25,
				effectiveCost: 1.25,
				listCost: 1.5,
				consumedQuantity: 120000.5,
				consumedUnit: "GB-seconds",
				tags: {},
				estimated: false,
			},
		])
	})

	it("leaves out rows inside the included allowance, and keeps one billed nothing at a list price", () => {
		const rows = usage([
			usageRow("2026-10-03", "Workers", "Workers Requests (First 10M are included)", 0),
			usageRow("2026-10-03", "R2", "R2 Storage", 0, { ListCost: 0.4 }),
			usageRow("2026-10-03", "Workers KV", "KV Reads", 0, { ConsumedQuantity: 3 }),
		])
		expect(Arr.map(rows, (row) => [row.usageType, row.billedCost, row.listCost])).toEqual([
			["R2 Storage", 0, 0.4],
		])
	})

	it("keeps only the window's days, and marks the newest two as open to change", () => {
		const rows = usage([
			usageRow("2026-09-30", "R2", "R2 Storage", 1),
			usageRow("2026-10-01", "R2", "R2 Storage", 2),
			usageRow("2026-11-08", "R2", "R2 Storage", 3),
			usageRow("2026-11-09", "R2", "R2 Storage", 4),
			usageRow("2026-11-10", "R2", "R2 Storage", 5),
			usageRow("2026-11-11", "R2", "R2 Storage", 6),
		])
		expect(Arr.map(rows, (row) => [row.day, row.billedCost, row.estimated])).toEqual([
			["2026-10-01", 2, false],
			["2026-11-08", 3, false],
			["2026-11-09", 4, true],
			["2026-11-10", 5, true],
		])
	})

	it("puts each product in its category, and one it does not know in Other", () => {
		const families = ["Workers", "Queues", "Containers", "R2", "D1", "Workers KV", "Workers AI", "Email"]
		const rows = usage([
			...Arr.map(families, (family) => usageRow("2026-10-05", family, `${family} metric`, 1)),
			usageRow("2026-10-05", "Something New", "New metric", 1),
			usageRow("2026-10-05", "Workers", "No family", 1, { ServiceFamilyName: null }),
		])
		expect(Arr.map(rows, (row) => [row.cloudService, row.serviceCategory])).toEqual([
			["Workers", "Compute"],
			["Queues", "Compute"],
			["Containers", "Compute"],
			["R2", "Storage"],
			["D1", "Databases"],
			["Workers KV", "Databases"],
			["Workers AI", "AI and Machine Learning"],
			["Email", "Other"],
			["Something New", "Other"],
			["", "Other"],
		])
	})

	it("adds up two rows of one day and metric, which the warehouse would read as one", () => {
		const rows = usage([
			usageRow("2026-10-05", "R2", "R2 Storage", 1.5, {
				ConsumedQuantity: 10,
				ConsumedUnit: "GB-months",
			}),
			usageRow("2026-10-05", "R2", "R2 Storage", 2.25, {
				ConsumedQuantity: 5,
				ConsumedUnit: "GB-months",
			}),
		])
		expect(Arr.map(rows, (row) => [row.billedCost, row.listCost, row.consumedQuantity])).toEqual([
			[3.75, 3.75, 15],
		])
	})

	it("keeps the row's own currency", () => {
		expect(
			usage([usageRow("2026-10-05", "R2", "R2 Storage", 1, { BillingCurrency: "EUR" })]),
		).toMatchObject([{ currency: "EUR" }])
	})
})

const plan = (over: FakeSubscription = {}): FakeSubscription => ({
	price: 5,
	currency: "USD",
	frequency: "monthly",
	current_period_start: "2026-11-04T09:12:44Z",
	created_date: "2025-03-04T09:12:44Z",
	rate_plan: { public_name: "Workers Paid" },
	product: { name: "workers" },
	...over,
})

describe("toSubscriptionRows", () => {
	it("puts a monthly fee on each period start in the window, stepped back from the current one", () => {
		const rows = fees([plan()])
		expect(Arr.map(rows, (row) => [row.day, row.billedCost, row.estimated])).toEqual([
			["2026-11-04", 5, false],
			["2026-10-04", 5, false],
		])
		expect(rows[0]).toEqual({
			day: "2026-11-04",
			accountId: ACCOUNT,
			cloudService: "Subscriptions",
			serviceCategory: "Other",
			usageType: "Workers Paid",
			region: "global",
			resourceId: "",
			resourceType: "",
			serviceName: "",
			chargeCategory: "purchase",
			basis: "billed",
			currency: "USD",
			billedCost: 5,
			effectiveCost: 5,
			listCost: 5,
			consumedQuantity: 0,
			consumedUnit: "",
			tags: {},
			estimated: false,
		})
	})

	it("names the zone a zone's plan belongs to", () => {
		const [row] = fees([
			plan({
				price: 10,
				rate_plan: { public_name: "Advanced Certificate Manager" },
				zone: { name: "example.com" },
			}),
		])
		expect([row?.usageType, row?.resourceId, row?.resourceType]).toEqual([
			"Advanced Certificate Manager",
			"example.com",
			"zone",
		])
	})

	it("never charges a period from before the subscription was created", () => {
		const rows = fees([
			plan({ created_date: "2026-10-20T00:00:00Z", current_period_start: "2026-11-01T00:00:00Z" }),
		])
		expect(Arr.map(rows, (row) => row.day)).toEqual(["2026-11-01"])
	})

	it("walks a year of monthly periods back, and keeps to the month's last day where it is shorter", () => {
		const rows = fees(
			[plan({ current_period_start: "2026-10-31T00:00:00Z", created_date: "2020-01-01T00:00:00Z" })],
			{
				startDay: "2025-12-01",
				endDay: "2026-11-10",
			},
		)
		expect(Arr.map(rows, (row) => row.day)).toEqual([
			"2026-10-31",
			"2026-09-30",
			"2026-08-31",
			"2026-07-31",
			"2026-06-30",
			"2026-05-31",
			"2026-04-30",
			"2026-03-31",
			"2026-02-28",
			"2026-01-31",
			"2025-12-31",
		])
	})

	it("charges a yearly fee once, on its current period's start", () => {
		const yearly = plan({ price: 120, frequency: "yearly", current_period_start: "2026-10-15T00:00:00Z" })
		expect(Arr.map(fees([yearly]), (row) => [row.day, row.billedCost])).toEqual([["2026-10-15", 120]])
		// A period that started before the window is not in it.
		expect(fees([{ ...yearly, current_period_start: "2026-03-15T00:00:00Z" }])).toEqual([])
	})

	it("leaves out free items, items with no period and frequencies it does not bill by", () => {
		expect(
			fees([
				plan({ price: 0 }),
				{ price: 0, frequency: "not-applicable", created_date: "2025-01-01T00:00:00Z" },
				plan({ frequency: "not-applicable" }),
				plan({ frequency: "quarterly" }),
				plan({ current_period_start: null }),
			]),
		).toEqual([])
	})

	it("adds up two subscriptions to one plan on one day, and marks an open day", () => {
		const rows = fees([
			plan({ current_period_start: "2026-11-09T00:00:00Z" }),
			plan({ current_period_start: "2026-11-09T12:00:00Z", price: 7 }),
		])
		expect(Arr.map(rows, (row) => [row.day, row.billedCost, row.estimated])).toEqual([
			["2026-11-09", 12, true],
			["2026-10-09", 12, false],
		])
	})
})
