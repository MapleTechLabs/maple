import { OrgId } from "@maple/domain"
import { RailwayEnvironmentStatus, RailwayIntegrationStatus } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import type { RailwayServiceRow } from "../model"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 06:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 06:05:00", endTime: "2026-10-01 12:05:00" }
const NOW = 1_790_000_000_000

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const status = (connected: boolean) =>
	new RailwayIntegrationStatus({
		connected,
		workspaceNames: null,
		connectedByUserId: null,
		connectedAt: null,
		authFailed: false,
		lastSyncedAt: NOW,
		lastError: null,
		environments: connected
			? [
					new RailwayEnvironmentStatus({
						projectId: "p1",
						projectName: "acme-shop",
						environmentId: "env_prod",
						environmentName: "production",
						serviceCount: 2,
						enabled: true,
						lastSyncedAt: NOW,
						lastError: null,
					}),
				]
			: [],
	})

const row = (serviceName: string, memoryAvg: number): RailwayServiceRow => ({
	environmentId: "env_prod",
	serviceId: `svc_${serviceName}`,
	serviceName,
	projectName: "acme-shop",
	environmentName: "production",
	cpuAvg: 0.5,
	cpuMax: 1,
	cpuLimit: 8,
	memoryAvg,
	memoryMax: memoryAvg * 2,
	memoryLimit: 8e9,
	replicas: 1,
	lastSeen: "2026-10-01 12:00:00",
})

const steps = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message).model, model)

/** Entered, windowed and the status answered. */
const withStatus = (connected: boolean): Model => {
	const entered = init({ search: {} }, context).model
	const windowed = steps(entered, [Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })])
	return steps(windowed, [
		Message.CompletedLoadStatus({
			key: windowed.status.key ?? "",
			result: Result.succeed(status(connected)),
		}),
	])
}

const loaded = (rows: ReadonlyArray<RailwayServiceRow>): Model => {
	const model = withStatus(true)
	return steps(model, [
		Message.CompletedFetchServices({ key: model.services.key ?? "", result: Result.succeed(rows) }),
	])
}

describe("railway list", () => {
	test("entry asks for the status and the window; services wait for a connected status", () => {
		const entered = init({ search: {} }, context)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining(["ResolveRailwayWindow", "LoadRailwayStatus"]),
		)
		const windowed = pageUpdate(
			entered.model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(windowed.commands)).toEqual([])
		const connected = pageUpdate(
			windowed.model,
			Message.CompletedLoadStatus({
				key: windowed.model.status.key ?? "",
				result: Result.succeed(status(true)),
			}),
		)
		expect(names(connected.commands)).toEqual(["FetchRailwayServices"])
	})

	test("a disconnected org never asks for services and links to the connect flow", () => {
		const model = withStatus(false)
		expect(model.services.key).toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("link", { name: "Connect Railway" })).toHaveAttr(
				"href",
				"/sources/new?integration=railway",
			),
		)
	})

	test("a services answer for a superseded window is dropped", () => {
		const first = withStatus(true)
		const second = pageUpdate(
			first,
			Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Load" }),
		)
		const late = pageUpdate(
			second.model,
			Message.CompletedFetchServices({
				key: first.services.key ?? "",
				result: Result.succeed([row("old", 1)]),
			}),
		)
		expect(late.model.services).toEqual(second.model.services)
	})

	test("loaded rows render under their environment, heaviest first", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([row("api", 1e9), row("postgres", 3e9)])),
			expectView(text("2 services")).toExist(),
			expectView(role("link", { name: /postgres/ })).toHaveAttr(
				"href",
				"/infra/railway/svc_postgres?environmentId=env_prod",
			),
		)
	})

	test("an empty window says so instead of an empty table", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([])),
			expectView(text("No Railway metrics in this window")).toExist(),
		)
	})

	test("typing in the search writes q to the URL; clearing drops it", () => {
		const model = loaded([row("api", 1)])
		expect(pageUpdate(model, Message.ChangedSearch({ value: "pg" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/railway?q=pg", isReplace: false }),
		)
		expect(pageUpdate(model, Message.ClickedClearSearch()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/railway", isReplace: false }),
		)
	})

	test("sorting starts descending, names ascending, and a second click flips it", () => {
		const model = loaded([row("api", 1)])
		const byCpu = pageUpdate(model, Message.ClickedSort({ key: "cpuMax" })).model
		expect(byCpu.sort).toEqual({ key: "cpuMax", dir: "desc" })
		const byName = pageUpdate(byCpu, Message.ClickedSort({ key: "displayName" })).model
		expect(byName.sort).toEqual({ key: "displayName", dir: "asc" })
		expect(pageUpdate(byName, Message.ClickedSort({ key: "displayName" })).model.sort.dir).toBe("desc")
	})
})
