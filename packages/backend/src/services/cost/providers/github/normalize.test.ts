import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Order } from "effect"
import { toCostRows, type UsageItem } from "./normalize"

const WINDOW = { startDay: "2026-11-01", endDay: "2026-11-03" }
const ACCOUNT = "example-org"
/** Yesterday at pull time: its usage and today's can still change. */
const OPEN_DAY = "2026-11-03"

const item = (overrides: Partial<UsageItem>): UsageItem => ({
	date: "2026-11-02T00:00:00Z",
	product: "actions",
	sku: "Actions Linux",
	quantity: 120,
	unitType: "Minutes",
	grossAmount: 0.96,
	netAmount: 0.96,
	repositoryName: "example-org/api",
	...overrides,
})

const rowsOf = (items: ReadonlyArray<UsageItem>) => toCostRows(items, ACCOUNT, WINDOW, OPEN_DAY)

/** `day | service | usage type | repository | billed | list | quantity` of each row, in a stable order. */
const summary = (items: ReadonlyArray<UsageItem>) =>
	Arr.sort(
		Arr.map(rowsOf(items), (row) =>
			Arr.join(
				[
					row.day,
					row.cloudService,
					row.usageType,
					row.resourceId,
					`${row.billedCost}`,
					`${row.listCost}`,
					`${row.consumedQuantity}`,
				],
				" | ",
			),
		),
		Order.String,
	)

describe("toCostRows", () => {
	it("names the product as the service, the SKU as the usage type and the repository as the resource", () => {
		const [row] = rowsOf([item({})])
		assert.deepStrictEqual(
			{
				day: row?.day,
				accountId: row?.accountId,
				cloudService: row?.cloudService,
				serviceCategory: row?.serviceCategory,
				usageType: row?.usageType,
				region: row?.region,
				resourceId: row?.resourceId,
				resourceType: row?.resourceType,
				chargeCategory: row?.chargeCategory,
				basis: row?.basis,
				currency: row?.currency,
				billedCost: row?.billedCost,
				effectiveCost: row?.effectiveCost,
				listCost: row?.listCost,
				consumedQuantity: row?.consumedQuantity,
				consumedUnit: row?.consumedUnit,
			},
			{
				day: "2026-11-02",
				accountId: ACCOUNT,
				cloudService: "Actions",
				serviceCategory: "Developer Tools",
				usageType: "Actions Linux",
				region: "global",
				resourceId: "example-org/api",
				resourceType: "repository",
				chargeCategory: "usage",
				basis: "billed",
				currency: "USD",
				billedCost: 0.96,
				effectiveCost: 0.96,
				listCost: 0.96,
				consumedQuantity: 120,
				consumedUnit: "Minutes",
			},
		)
	})

	it("reads the day off a timestamp that is not at midnight, and sums the lines that share a day", () => {
		assert.deepStrictEqual(
			summary([
				item({ date: "2026-11-02T00:00:00Z", quantity: 10, grossAmount: 1, netAmount: 1 }),
				item({ date: "2026-11-02T11:12:05Z", quantity: 2.5, grossAmount: 2, netAmount: 2 }),
				item({ date: "2026-11-03T08:00:00Z", quantity: 4, grossAmount: 4, netAmount: 4 }),
			]),
			[
				"2026-11-02 | Actions | Actions Linux | example-org/api | 3 | 3 | 12.5",
				"2026-11-03 | Actions | Actions Linux | example-org/api | 4 | 4 | 4",
			],
		)
	})

	it("keeps SKUs and repositories apart", () => {
		assert.deepStrictEqual(
			summary([
				item({ grossAmount: 1, netAmount: 1, quantity: 1 }),
				item({
					sku: "Actions storage",
					unitType: "GigabyteHours",
					grossAmount: 2,
					netAmount: 2,
					quantity: 2,
				}),
				item({ repositoryName: "example-org/web", grossAmount: 4, netAmount: 4, quantity: 4 }),
			]),
			[
				"2026-11-02 | Actions | Actions Linux | example-org/api | 1 | 1 | 1",
				"2026-11-02 | Actions | Actions Linux | example-org/web | 4 | 4 | 4",
				"2026-11-02 | Actions | Actions storage | example-org/api | 2 | 2 | 2",
			],
		)
	})

	it("keeps the list cost of usage a plan allowance or a public repository made free", () => {
		const [row] = rowsOf([item({ grossAmount: 0.8, netAmount: 0 })])
		assert.deepStrictEqual([row?.billedCost, row?.effectiveCost, row?.listCost], [0, 0, 0.8])
	})

	it("leaves out a line with neither a gross nor a net amount, and days outside the window", () => {
		assert.deepStrictEqual(
			summary([
				item({ grossAmount: 0, netAmount: 0 }),
				item({ date: "2026-10-31T23:59:59Z" }),
				item({ date: "2026-11-04T00:00:00Z" }),
				item({ date: "2026-11-01T00:00:00Z", grossAmount: 0.5, netAmount: 0.5, quantity: 1 }),
			]),
			["2026-11-01 | Actions | Actions Linux | example-org/api | 0.5 | 0.5 | 1"],
		)
	})

	it("keeps a line with no repository, as a seat product has none", () => {
		const rows = rowsOf([
			item({
				product: "copilot",
				sku: "Copilot Business",
				unitType: "UserMonths",
				repositoryName: null,
			}),
			item({
				product: "copilot",
				sku: "Copilot Business",
				unitType: "UserMonths",
				repositoryName: undefined,
			}),
		])
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.cloudService, row.resourceId, row.resourceType, row.billedCost]),
			[["Copilot", "", "", 1.92]],
		)
	})

	it("writes a product as GitHub does, and one it does not know with a capital", () => {
		const names = (product: string) => rowsOf([item({ product })])[0]?.cloudService
		assert.deepStrictEqual(
			Arr.map(["actions", "copilot", "packages", "codespaces", "git_lfs", "models"], names),
			["Actions", "Copilot", "Packages", "Codespaces", "Git LFS", "Models"],
		)
	})

	it("marks yesterday and today as not final, and the days before as final", () => {
		const rows = rowsOf([
			item({ date: "2026-11-01T00:00:00Z" }),
			item({ date: "2026-11-02T00:00:00Z" }),
			item({ date: "2026-11-03T00:00:00Z" }),
		])
		assert.deepStrictEqual(
			Arr.sort(
				Arr.map(rows, (row) => `${row.day} ${row.estimated}`),
				Order.String,
			),
			["2026-11-01 false", "2026-11-02 false", "2026-11-03 true"],
		)
	})
})
