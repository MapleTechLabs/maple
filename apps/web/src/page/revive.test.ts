import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import { AppRoute } from "../route"
import type { PageContext } from "./contract"
import { enterRoute, PageMessage, type PageSlot, parkPages, updatePage } from "./registry"
import { Message } from "./services/list/message"
import type { ServiceRow } from "./services/list/model"

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
		expect(back.commands.map((command) => command.name)).toContain("ResolveServicesWindow")
	})

	test("a page left mid-load is not parked: coming back builds it fresh", () => {
		const left = servicesPage(1, false)
		expect(parkPages([], left, enterRoute(left, home, context, 2).slot)).toEqual([])
	})

	test("switching org drops the pages parked for the previous one", () => {
		const left = servicesPage(1, true)
		const parked = parkPages([], left, enterRoute(left, home, context, 2).slot)
		expect(parkPages(parked, null, enterRoute(null, home, otherContext, 3).slot)).toEqual([])
	})
})
