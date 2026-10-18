import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import type { DatabaseList } from "../data"
import { selectedBranchOf, timeseriesInputOf } from "./derive"
import { Message, type Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const route = { dbName: "acme-prod", search: {} }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const inventory: DatabaseList = {
	object: "planetscale_integration.database_list",
	last_inventory_at: null,
	databases: [
		{
			id: "db1",
			object: "planetscale_integration.database",
			name: "acme-prod",
			kind: "postgresql",
			state: "ready",
			region: "us-east",
			plan: "scaler_pro",
			branches: [
				{ id: "b1", name: "dev", production: false, ready: true },
				{ id: "b2", name: "main", production: true, ready: true },
			],
		},
	],
}

const windowed = () =>
	pageUpdate(init(route, context).model, Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }))

describe("planetscale database", () => {
	test("entry asks for status and inventory; the window brings the branch stats and the scoped reads", () => {
		expect(names(init(route, context).commands)).toEqual([
			"ResolvePlanetscaleDatabaseWindow",
			"LoadPlanetscaleDatabaseStatus",
			"FetchPlanetscaleInventory",
			"ReadRememberedFilterSections",
			"LoadChartRuntime",
		])
		expect(names(windowed().commands)).toEqual([
			"FetchPlanetscaleBranchStats",
			"FetchPlanetscaleTimeseries",
			"FetchPlanetscaleEvents",
			"FetchPlanetscaleQueryInsights",
		])
	})

	test("the inventory resolves the production branch, which re-keys the scoped reads", () => {
		const model = windowed().model
		expect(timeseriesInputOf(model, window).branch).toBeUndefined()
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchDatabases({ key: model.databases.key ?? "", result: Result.succeed(inventory) }),
		)
		expect(selectedBranchOf(loaded.model)?.name).toBe("main")
		expect(names(loaded.commands)).toEqual([
			"FetchPlanetscaleTimeseries",
			"FetchPlanetscaleEvents",
			"FetchPlanetscaleQueryInsights",
		])
		expect(loaded.model.timeseries.key).not.toBe(model.timeseries.key)
	})

	test("the sidebar and breakdown write the plural branches filter and drop the legacy ?branch=", () => {
		const model = pageUpdate(init({ ...route, search: { branch: "main" } }, context).model, Message.ToggledBranch({ branch: "dev" }))
		expect(model.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: '/infra/planetscale/acme-prod?branches=%5B%22main%22%2C%22dev%22%5D',
				isReplace: false,
			}),
		)
	})

	test("the measure pivot is local state; clearing filters keeps the window", () => {
		const model = windowed().model
		expect(pageUpdate(model, Message.ClickedMeasure({ measure: "cpu" })).model.measure).toBe("cpu")
		const cleared = pageUpdate(
			init({ ...route, search: { timePreset: "1d", branches: ["dev"] } }, context).model,
			Message.ClickedClearFilters(),
		)
		expect(cleared.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/planetscale/acme-prod?timePreset=1d", isReplace: false }),
		)
	})
})
