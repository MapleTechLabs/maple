import { OrgId } from "@maple/domain"
import { Effect, Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { beforeAll, describe, expect, test } from "vitest"
import { AppRoute } from "../route"
import type { PageContext } from "./contract"
import { enterRoute, PageMessage, type PageSlot, parkPages, updatePage, loadEveryPage } from "./registry"
import { DEFAULT_QUICK_START_STATE } from "./onboarding/quick-start-state"
import { IncidentsData, RulesData } from "./overview/model"
import * as Setup from "./overview/setup-checklist-update"
import { Message as OverviewMessage } from "./overview/message"
import { initWith, revive as reviveOverview } from "./overview/update"
import { Message } from "./services/list/message"
import type { ServiceRow } from "./services/list/model"

// Pages enter only once their code is loaded (`loadPageCode`); these tests drive loaded pages.
beforeAll(() => Effect.runPromise(loadEveryPage))

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const otherContext: PageContext = { ...context, orgId: Schema.decodeSync(OrgId)("org_other") }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const services = AppRoute.Services({ search: {} })
const home = AppRoute.Home({ search: {} })

const row: ServiceRow = {
	serviceName: "checkout",
	serviceNamespace: "",
	environment: "production",
	commits: [],
	p50LatencyMs: 10,
	p95LatencyMs: 20,
	p99LatencyMs: 30,
	errorRate: 0,
	throughput: 1,
	tracedThroughput: 1,
	hasSampling: false,
	samplingWeight: 1,
	spanCount: 100,
}

const stamp = (slot: PageSlot, message: Message): PageMessage => ({
	_tag: "ServicesList",
	key: slot.key,
	orgId: slot.orgId,
	instance: slot.instance,
	message,
})

const stampOverview = (slot: PageSlot, message: OverviewMessage): PageMessage => ({
	_tag: "Overview",
	key: slot.key,
	orgId: slot.orgId,
	instance: slot.instance,
	message,
})

const send = (slot: PageSlot | null, message: Message): PageSlot | null =>
	slot === null ? null : updatePage(slot, stamp(slot, message), context).slot

const servicesModel = (slot: PageSlot | null) => (slot?._tag === "ServicesList" ? slot.model : null)

/** The services list as instance `instance`, windowed; `isSettled` answers every read it sent. */
const servicesPage = (instance: number, isSettled: boolean): PageSlot | null => {
	const windowed = send(
		enterRoute(null, services, context, instance).slot,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	)
	const model = servicesModel(windowed)
	if (!isSettled || model === null) return windowed
	return [
		Message.CompletedFetchOverview({ key: model.overview.key ?? "", result: Result.succeed([row]) }),
		Message.CompletedFetchSparklines({ key: model.sparklines.key ?? "", result: Result.succeed({}) }),
		Message.CompletedFetchAnomalies({ key: model.anomalies.key ?? "", result: Result.succeed([]) }),
		Message.CompletedFetchFacets({
			key: model.facets.key ?? "",
			result: Result.succeed({ environments: [], namespaces: [], commitShas: [] }),
		}),
		Message.CompletedFetchBaseline({ key: model.baseline.key ?? "", result: Result.succeed([]) }),
		Message.UpdatedIncidents({ orgId, incidents: [] }),
		Message.CompletedLoadChartRuntime(),
		Message.CompletedLoadSignalPresence({ result: Result.succeed({}) }),
	].reduce(send, windowed)
}

describe("reviving a page left earlier", () => {
	test("back on the services list, the last rows show at once while it reloads", () => {
		const left = servicesPage(1, true)
		const overview = enterRoute(left, home, context, 2).slot
		const parked = parkPages([], left, overview)
		const back = enterRoute(overview, services, context, 3, parked)
		const model = servicesModel(back.slot)
		expect(back.slot?.instance).toBe(3)
		expect(model === null ? Option.none() : AsyncData.getData(model.overview.data)).toEqual(
			Option.some([row]),
		)
		// Re-resolved like entry: snapped, so a read still cached is served, not forced.
		expect(back.commands.map((command) => [command.name, command.args])).toContainEqual([
			"ResolveServicesWindow",
			expect.objectContaining({ mode: "Load" }),
		])
	})

	test("coming back through a link with other filters takes the new search and a fresh window", () => {
		const left = servicesPage(1, true)
		const overview = enterRoute(left, home, context, 2).slot
		const filtered = AppRoute.Services({ search: { environments: ["staging"], timePreset: "1h" } })
		const back = enterRoute(overview, filtered, context, 3, parkPages([], left, overview))
		expect(servicesModel(back.slot)?.search).toEqual(filtered.search)
		expect(back.commands.map((command) => [command.name, command.args])).toContainEqual([
			"ResolveServicesWindow",
			expect.objectContaining({ mode: "Load", preset: "1h" }),
		])
	})

	test("the overview comes back with no setup read left waiting, and re-reads its entry", () => {
		const { model } = initWith(true)({ search: {} }, context)
		const setup = model.setup === null ? null : { ...model.setup, isOverviewInFlight: true }
		const back = reviveOverview(
			{ ...model, setup, isReloading: true, refreshVersion: 2 },
			{ search: {} },
			context,
		)
		expect(back.model.setup?.isOverviewInFlight).toBe(false)
		expect([back.model.isReloading, back.model.refreshVersion]).toEqual([false, 0])
		expect((back.commands ?? []).map((command) => command.name)).toContain("ReadOverviewEntry")
	})

	test("an overview with a dismissed setup card is parked, though its card never read the keys", () => {
		const entered = enterRoute(null, home, context, 1).slot
		const overview =
			entered?._tag === "Overview"
				? {
						...entered,
						model: {
							...entered.model,
							incidents: IncidentsData.Success({ data: [] }),
							rules: RulesData.Success({ data: [] }),
							presence: AsyncData.Success({ data: {} }),
							chartRuntime: { _tag: "Ready" as const },
							setup: {
								...Setup.init("maple-onboarding-v6-org_acme").model,
								state: { ...DEFAULT_QUICK_START_STATE, checklistDismissed: true },
							},
						},
					}
				: null
		const away = enterRoute(overview, services, context, 2).slot
		const parked = parkPages([], overview, away)
		expect(parked.map((slot) => slot._tag)).toEqual(["Overview"])
		expect(enterRoute(away, home, context, 3, parked).slot?.instance).toBe(3)
	})

	test("the overview asks again for what was dropped while parked: setup keys and a failed chart runtime", () => {
		const { model } = initWith(true)({ search: {} }, context)
		const setup =
			model.setup === null
				? null
				: { ...model.setup, state: DEFAULT_QUICK_START_STATE, keys: { _tag: "Pending" as const } }
		const parkedModel = { ...model, setup, chartRuntime: { _tag: "Failed" as const, reason: "boom" } }
		const back = reviveOverview(parkedModel, { search: {} }, context)
		const names = (back.commands ?? []).map((command) => command.name)
		expect(names).toContain("FetchSetupChecklistKeys")
		expect(names.some((name) => name.includes("ChartRuntime"))).toBe(true)
		expect(back.model.chartRuntime._tag).toBe("Loading")
	})

	test("an overview whose live alert sync failed is parked: failure is an end state", () => {
		const entered = enterRoute(null, home, context, 1).slot
		const failed = [
			OverviewMessage.FailedLoadIncidents({ orgId }),
			OverviewMessage.FailedLoadRules({ orgId }),
			OverviewMessage.CompletedLoadSignalPresence({ result: Result.succeed({}) }),
			OverviewMessage.CompletedLoadChartRuntime(),
		].reduce<PageSlot | null>(
			(slot, message) =>
				slot === null ? null : updatePage(slot, stampOverview(slot, message), context).slot,
			entered,
		)
		expect(
			parkPages([], failed, enterRoute(failed, services, context, 2).slot).map((slot) => slot._tag),
		).toEqual(["Overview"])
	})

	test("a page left mid-load is not parked: coming back builds it fresh", () => {
		const left = servicesPage(1, false)
		expect(parkPages([], left, enterRoute(left, home, context, 2).slot)).toEqual([])
	})

	test("leaving the same page twice keeps one parked copy, the newest", () => {
		const first = servicesPage(1, true)
		const once = parkPages([], first, enterRoute(first, home, context, 2).slot)
		const second = servicesPage(3, true)
		const twice = parkPages(once, second, enterRoute(second, home, context, 4).slot)
		expect(twice.map((slot) => [slot._tag, slot.instance])).toEqual([["ServicesList", 3]])
	})

	test("switching org drops the pages parked for the previous one", () => {
		const left = servicesPage(1, true)
		const parked = parkPages([], left, enterRoute(left, home, context, 2).slot)
		expect(parkPages(parked, null, enterRoute(null, home, otherContext, 3).slot)).toEqual([])
	})
})
