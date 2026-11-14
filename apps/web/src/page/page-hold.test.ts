import { OrgId } from "@maple/domain"
import { Option, Result, Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { AppRoute } from "../route"
import type { PageContext } from "./contract"
import { elapsed, isRevived, Model, shownSlot, startedHold, written } from "./page-hold"
import { enterRoute, type PageMessage, type PageSlot, updatePage } from "./registry"
import { Message } from "./services/list/message"
import { Message as TracesMessage } from "./traces/list/message"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const slotOf = (route: AppRoute, instance: number, pageContext = context): PageSlot =>
	Option.getOrThrow(Option.fromNullishOr(enterRoute(null, route, pageContext, instance).slot))

const stamp = (slot: PageSlot, message: Message): PageMessage => ({
	_tag: "ServicesList",
	key: slot.key,
	orgId: slot.orgId,
	instance: slot.instance,
	message,
})

const sendServices = (slot: PageSlot, message: Message): PageSlot =>
	Option.getOrThrow(Option.fromNullishOr(updatePage(slot, stamp(slot, message), context).slot))

/** The services list with its window resolved: its reads are out, nothing to show yet. */
const loadingServices = (instance: number): PageSlot =>
	sendServices(
		slotOf(AppRoute.Services({ search: {} }), instance),
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	)

/** The same page once its first read landed: it has rows to show while the rest load. */
const servicesWithRows = (slot: PageSlot): PageSlot => {
	const key = slot._tag === "ServicesList" ? (slot.model.overview.key ?? "") : ""
	return sendServices(slot, Message.CompletedFetchOverview({ key, result: Result.succeed([]) }))
}

/** Every read the services list sent, answered. */
const settledServices = (slot: PageSlot): PageSlot => {
	const model = slot._tag === "ServicesList" ? slot.model : null
	if (model === null) return slot
	return Arr.reduce(
		[
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
		],
		slot,
		sendServices,
	)
}

/** The page left: the services list with its rows on screen. */
const left = servicesWithRows(loadingServices(1))
const NONE = Model.None()

/** A navigation or page write to a page built fresh (not revived). */
const step = (hold: Model, previous: PageSlot | null, next: PageSlot | null) =>
	written(hold, previous, next, false)

describe("navigation hold", () => {
	test("entering a page with nothing to show keeps the page left on screen and starts the timer", () => {
		const services = loadingServices(2)
		const hold = step(NONE, left, services)
		expect(hold).toEqual(Model.Holding({ leaving: left, instance: 2 }))
		expect(shownSlot(hold, services)).toBe(left)
		expect(startedHold(NONE, hold)).toBe(2)
	})

	test("a parked page coming back shows at once with its last data", () => {
		const services = loadingServices(2)
		expect(isRevived([left], services)).toBe(true)
		expect(written(NONE, left, services, isRevived([left], services))).toEqual(NONE)
		expect(isRevived([], services)).toBe(false)
	})

	test("a side read landing first keeps the hold; the page's reads landing end it before the timer", () => {
		const services = loadingServices(2)
		const holding = step(NONE, left, services)
		const presence = sendServices(
			services,
			Message.CompletedLoadSignalPresence({ result: Result.succeed({}) }),
		)
		expect(step(holding, services, presence)).toBe(holding)
		expect(startedHold(holding, holding)).toBeNull()
		const landed = settledServices(servicesWithRows(services))
		expect(shownSlot(step(holding, services, landed), landed)).toBe(landed)
	})

	test("a page whose main reads wait on its window stays held when a cached side read lands first", () => {
		const traces = slotOf(AppRoute.Traces({ search: {} }), 2)
		const holding = step(NONE, left, traces)
		expect(holding).toEqual(Model.Holding({ leaving: left, instance: 2 }))
		const message: PageMessage = {
			_tag: "TracesList",
			key: traces.key,
			orgId: traces.orgId,
			instance: traces.instance,
			message: TracesMessage.CompletedLoadSignalPresence({ result: Result.succeed({}) }),
		}
		const presence = Option.getOrThrow(Option.fromNullishOr(updatePage(traces, message, context).slot))
		expect(step(holding, traces, presence)).toBe(holding)
	})

	test("the timer running out shows the page; its skeletons skip their delay until it has data", () => {
		const services = loadingServices(2)
		const waited = elapsed(step(NONE, left, services), 2, services)
		expect(waited).toEqual(Model.Waited({ instance: 2 }))
		expect(shownSlot(waited, services)).toBe(services)
		// One read landing keeps the 0ms delay, so the skeletons still up do not blink out.
		const partly = servicesWithRows(services)
		expect(step(waited, services, partly)).toBe(waited)
		expect(step(waited, partly, settledServices(partly))).toEqual(NONE)
	})

	test("a page that is itself still a skeleton is not held over the next, even once a side read answered", () => {
		expect(step(NONE, loadingServices(1), loadingServices(2))).toEqual(NONE)
		const presence = sendServices(
			loadingServices(1),
			Message.CompletedLoadSignalPresence({ result: Result.succeed({}) }),
		)
		expect(step(NONE, presence, loadingServices(2))).toEqual(NONE)
	})

	test("a second navigation during a hold keeps the page on screen, under the new page's timer", () => {
		const services = loadingServices(2)
		const holding = step(NONE, left, services)
		const next = loadingServices(3)
		const again = step(holding, services, next)
		expect(again).toEqual(Model.Holding({ leaving: left, instance: 3 }))
		expect(startedHold(holding, again)).toBe(3)
		expect(elapsed(again, 2, next)).toBe(again)
	})

	test("never across orgs, into or out of a bare page, or with nothing on screen before", () => {
		const otherOrg: PageContext = { ...context, orgId: Schema.decodeSync(OrgId)("org_other") }
		const elsewhere = slotOf(AppRoute.Services({ search: {} }), 2, otherOrg)
		expect(step(NONE, left, elsewhere)).toEqual(NONE)
		const share = slotOf(AppRoute.Share({ token: "tok_1", search: {} }), 2)
		expect(step(NONE, left, share)).toEqual(NONE)
		expect(step(NONE, share, loadingServices(3))).toEqual(NONE)
		expect(step(NONE, null, loadingServices(2))).toEqual(NONE)
		expect(step(step(NONE, left, loadingServices(2)), loadingServices(2), null)).toEqual(NONE)
	})
})
