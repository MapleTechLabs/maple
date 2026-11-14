import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { AppRoute } from "../route"
import type { PageContext } from "./contract"
import { elapsed, Model, shownSlot, startedHold, written } from "./page-hold"
import { enterRoute, type PageMessage, type PageSlot, updatePage } from "./registry"
import { Message } from "./services/list/message"

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

const logs = slotOf(AppRoute.Logs({ search: {} }), 1)
const NONE = Model.None()

describe("navigation hold", () => {
	test("entering a page with nothing to show keeps the page left on screen and starts the timer", () => {
		const services = loadingServices(2)
		const hold = written(NONE, logs, services)
		expect(hold).toEqual(Model.Holding({ leaving: logs, instance: 2 }))
		expect(shownSlot(hold, services)).toBe(logs)
		expect(startedHold(NONE, hold)).toBe(2)
	})

	test("a page with something to show (a cache hit, a revived page) shows at once", () => {
		const services = servicesWithRows(loadingServices(2))
		expect(written(NONE, logs, services)).toEqual(NONE)
	})

	test("the entered page's first read landing ends the hold before the timer", () => {
		const services = loadingServices(2)
		const holding = written(NONE, logs, services)
		expect(written(holding, services, services)).toBe(holding)
		expect(startedHold(holding, holding)).toBeNull()
		const landed = servicesWithRows(services)
		expect(shownSlot(written(holding, services, landed), landed)).toBe(landed)
	})

	test("the timer running out shows the page; its skeletons skip their delay until it has data", () => {
		const services = loadingServices(2)
		const waited = elapsed(written(NONE, logs, services), 2, services)
		expect(waited).toEqual(Model.Waited({ instance: 2 }))
		expect(shownSlot(waited, services)).toBe(services)
		expect(written(waited, services, servicesWithRows(services))).toEqual(NONE)
	})

	test("a second navigation during a hold keeps the page on screen, under the new page's timer", () => {
		const services = loadingServices(2)
		const holding = written(NONE, logs, services)
		const next = loadingServices(3)
		const again = written(holding, services, next)
		expect(again).toEqual(Model.Holding({ leaving: logs, instance: 3 }))
		expect(startedHold(holding, again)).toBe(3)
		expect(elapsed(again, 2, next)).toBe(again)
	})

	test("never across orgs, into or out of a bare page, or with nothing on screen before", () => {
		const otherOrg: PageContext = { ...context, orgId: Schema.decodeSync(OrgId)("org_other") }
		const elsewhere = slotOf(AppRoute.Services({ search: {} }), 2, otherOrg)
		expect(written(NONE, logs, elsewhere)).toEqual(NONE)
		const share = slotOf(AppRoute.Share({ token: "tok_1", search: {} }), 2)
		expect(written(NONE, logs, share)).toEqual(NONE)
		expect(written(NONE, share, loadingServices(3))).toEqual(NONE)
		expect(written(NONE, null, loadingServices(2))).toEqual(NONE)
		expect(written(written(NONE, logs, loadingServices(2)), loadingServices(2), null)).toEqual(NONE)
	})
})
