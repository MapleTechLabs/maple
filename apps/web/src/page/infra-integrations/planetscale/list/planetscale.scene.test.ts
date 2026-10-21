import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import type { DatabaseList, DatabaseStat, PlanetscaleStatus } from "../data"
import { Message, type Model } from "./model"
import { init, sortOf, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 00:05:00", endTime: "2026-10-01 12:05:00" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const status = (connected: boolean): PlanetscaleStatus => ({
	object: "planetscale_integration",
	connected,
	pending_org_selection: false,
	organization: connected ? "acme" : null,
	connected_by_user_id: null,
	detected_permissions: null,
	metrics_auth: "service_token",
	scrape_target: null,
	last_inventory_at: null,
	last_inventory_error: null,
	revoked_at: null,
	expires_at: null,
})

const inventory: DatabaseList = {
	object: "planetscale_integration.database_list",
	last_inventory_at: null,
	databases: [],
}

const stat = (database: string, storageUsedPercent: number): DatabaseStat => ({
	database,
	connectionsAvg: 10,
	connectionsMax: 20,
	cpuMaxPercent: 30,
	memMaxPercent: 40,
	replicaLagMaxSeconds: 0.2,
	storageUsedPercent,
})

const withStatus = (connected: boolean) => {
	const entered = init({ search: {} }, context)
	const windowed = pageUpdate(
		entered.model,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	).model
	return pageUpdate(
		windowed,
		Message.CompletedLoadStatus({
			key: windowed.status.key ?? "",
			result: Result.succeed(status(connected)),
		}),
	)
}

describe("planetscale list", () => {
	test("a connected status brings the inventory and the window's stats", () => {
		expect(names(init({ search: {} }, context).commands)).toEqual(
			expect.arrayContaining(["ResolvePlanetscaleWindow", "LoadPlanetscaleStatus"]),
		)
		expect(names(withStatus(true).commands)).toEqual(
			expect.arrayContaining(["FetchPlanetscaleDatabases", "FetchPlanetscaleDatabaseStats"]),
		)
	})

	test("a disconnected org asks for nothing more and offers the connection", () => {
		const step = withStatus(false)
		expect(names(step.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			expectView(role("link", { name: "Connect PlanetScale" })).toHaveAttr(
				"href",
				"/integrations?integration=planetscale",
			),
		)
	})

	test("stats for a superseded window are dropped", () => {
		const first = withStatus(true).model
		const second = pageUpdate(
			first,
			Message.CompletedResolveWindow({ window: later, nowMs: 0, mode: "Load" }),
		).model
		const late = pageUpdate(
			second,
			Message.CompletedFetchStats({
				key: first.stats.key ?? "",
				result: Result.succeed([stat("a", 50)]),
			}),
		)
		expect(late.model.stats).toEqual(second.stats)
	})

	test("an empty inventory says nothing was discovered", () => {
		const model = withStatus(true).model
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchDatabases({
				key: model.databases.key ?? "",
				result: Result.succeed(inventory),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			expectView(text("No databases discovered yet")).toExist(),
		)
	})

	test("before any scrape the table sorts by name; a head click re-sorts it", () => {
		const model = withStatus(true).model
		expect(sortOf(model)).toEqual({ key: "name", dir: "desc" })
		expect(sortOf(pageUpdate(model, Message.ClickedSort({ key: "name" })).model)).toEqual({
			key: "name",
			dir: "asc",
		})
		const byStorage = pageUpdate(model, Message.ClickedSort({ key: "storageUsedPercent" })).model
		expect(sortOf(byStorage)).toEqual({ key: "storageUsedPercent", dir: "desc" })
	})

	test("picking a preset writes it to the URL", () => {
		const model = withStatus(true).model
		expect(pageUpdate(model, Message.ClickedResetTimeRange()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/infra/planetscale?timePreset=12h",
				isReplace: false,
			}),
		)
	})
})
