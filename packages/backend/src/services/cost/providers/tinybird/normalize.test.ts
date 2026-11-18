import { assert, describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import type { CostPullRow } from "../../CostProvider"
import { toCostRows, type TinybirdUsage } from "./normalize"
import type { Workspace } from "./tinybird-cost-api"

const ACCOUNT = { accountId: "org_tb", region: "europe-west2" }
const WINDOW = { startDay: "2026-02-01", endDay: "2026-11-10" }
const OPEN_DAY = "2026-11-08"
const WORKSPACES: ReadonlyArray<Workspace> = [
	{ workspace_id: "ws_1", name: "maple_prod", live: 1 },
	{ workspace_id: "ws_2", name: "maple_staging", live: 1 },
]

const usage = (over: Partial<TinybirdUsage>): TinybirdUsage => ({
	workspaces: WORKSPACES,
	compute: [],
	storage: [],
	transfer: [],
	...over,
})

const rowsOf = (over: Partial<TinybirdUsage>) => toCostRows(usage(over), ACCOUNT, WINDOW, OPEN_DAY)

const summary = (rows: ReadonlyArray<CostPullRow>) =>
	Arr.map(rows, (row) => [
		row.day,
		row.cloudService,
		row.usageType,
		row.resourceId,
		row.consumedQuantity,
		row.consumedUnit,
	])

describe("toCostRows", () => {
	it("prices vCPU overage per second, as estimated usage on the host's region", () => {
		const [row, ...rest] = rowsOf({ compute: [{ day: "2026-11-09", overage_seconds: 1000 }] })
		assert.deepStrictEqual(rest, [])
		assert.closeTo(row?.billedCost ?? 0, 0.2, 1e-12)
		assert.deepStrictEqual(
			{ ...row, billedCost: 0.2, effectiveCost: 0.2, listCost: 0.2 },
			{
				day: "2026-11-09",
				accountId: "org_tb",
				cloudService: "Tinybird compute",
				serviceCategory: "Analytics",
				usageType: "vCPU overage",
				region: "europe-west2",
				resourceId: "",
				resourceType: "",
				serviceName: "",
				chargeCategory: "usage",
				basis: "estimated",
				currency: "USD",
				billedCost: 0.2,
				effectiveCost: 0.2,
				listCost: 0.2,
				consumedQuantity: 1000,
				consumedUnit: "vCPU-second",
				tags: {},
				estimated: true,
			},
		)
	})

	it("charges a day's stored GB a share of the month by the month's length", () => {
		const rows = rowsOf({
			storage: [
				// 100 GB on a day of February (28 days) and of October (31 days).
				{ day: "2026-02-10", workspace_id: "ws_1", bytes: 100e9 },
				{ day: "2026-10-10", workspace_id: "ws_1", bytes: 100e9 },
			],
		})
		assert.deepStrictEqual(summary(rows), [
			["2026-02-10", "Tinybird storage", "Storage", "maple_prod", 100, "GB-day"],
			["2026-10-10", "Tinybird storage", "Storage", "maple_prod", 100, "GB-day"],
		])
		assert.closeTo(rows[0]?.billedCost ?? 0, (100 * 0.058) / 28, 1e-12)
		assert.closeTo(rows[1]?.billedCost ?? 0, (100 * 0.058) / 31, 1e-12)
		assert.isFalse(rows[1]?.estimated)
	})

	it("prices intra- and inter-region transfer apart, and names a deleted workspace by its id", () => {
		const rows = rowsOf({
			transfer: [
				{ day: "2026-11-01", workspace_id: "ws_1", kind: "intra", bytes: 50e9 },
				{ day: "2026-11-01", workspace_id: "ws_gone", kind: "inter", bytes: 5e9 },
				// A kind Tinybird adds later has no price, so it is not guessed.
				{ day: "2026-11-01", workspace_id: "ws_1", kind: "egress", bytes: 900e9 },
			],
		})
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.usageType, row.resourceId, row.consumedQuantity, row.billedCost]),
			[
				["Intra-region transfer", "maple_prod", 50, 50 * 0.01],
				["Inter-region transfer", "ws_gone", 5, 5 * 0.1],
			],
		)
	})

	it("keeps costs under a cent, and leaves out no cost and days outside the window", () => {
		const rows = rowsOf({
			compute: [
				{ day: "2026-11-02", overage_seconds: 10 },
				{ day: "2026-11-03", overage_seconds: 0 },
				{ day: "2026-11-11", overage_seconds: 100000 },
			],
			storage: [{ day: "2026-11-02", workspace_id: "ws_1", bytes: 1e9 }],
		})
		assert.deepStrictEqual(
			Arr.map(rows, (row) => [row.day, row.cloudService]),
			[
				["2026-11-02", "Tinybird compute"],
				["2026-11-02", "Tinybird storage"],
			],
		)
		assert.closeTo(
			Arr.reduce(rows, 0, (total, row) => total + row.billedCost),
			0.002 + 0.058 / 30,
			1e-12,
		)
	})

	it("sums two workspaces of one name into one row", () => {
		const rows = toCostRows(
			usage({
				workspaces: [...WORKSPACES, { workspace_id: "ws_3", name: "maple_prod", live: 0 }],
				storage: [
					{ day: "2026-11-02", workspace_id: "ws_1", bytes: 300e9 },
					{ day: "2026-11-02", workspace_id: "ws_3", bytes: 200e9 },
				],
			}),
			ACCOUNT,
			WINDOW,
			OPEN_DAY,
		)
		assert.deepStrictEqual(summary(rows), [
			["2026-11-02", "Tinybird storage", "Storage", "maple_prod", 500, "GB-day"],
		])
		assert.closeTo(rows[0]?.billedCost ?? 0, (500 * 0.058) / 30, 1e-12)
	})
})
