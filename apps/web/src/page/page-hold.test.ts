import { describe, expect, test } from "vitest"
import { elapsed, noHold, type PageHold, shownSlot, startedHold, written } from "./page-hold"

const slot = (instance: number, orgId = "org_acme") => ({ _tag: "Logs", key: "logs", orgId, instance })
type Slot = ReturnType<typeof slot>

const services = slot(1)
const logs = slot(2)
const traces = slot(3)

describe("navigation hold", () => {
	test("entering a loading page keeps the page left on screen and starts the timer", () => {
		const hold = written<Slot>(noHold(), services, logs, true)
		expect(hold).toEqual({ _tag: "Holding", leaving: services, instance: 2 })
		expect(shownSlot(hold, logs)).toBe(services)
		expect(startedHold(noHold(), hold)).toBe(2)
	})

	test("a page with its data at hand (cache hit, revived) shows at once", () => {
		const hold = written<Slot>(noHold(), services, logs, false)
		expect(shownSlot(hold, logs)).toBe(logs)
		expect(startedHold(noHold(), hold)).toBeNull()
	})

	test("the entered page's first reads landing ends the hold before the timer", () => {
		const holding = written<Slot>(noHold(), services, logs, true)
		const stillLoading = written(holding, logs, logs, true)
		expect(stillLoading).toBe(holding)
		expect(startedHold(holding, stillLoading)).toBeNull()
		expect(shownSlot(written(holding, logs, logs, false), logs)).toBe(logs)
	})

	test("the timer running out shows the page; its skeletons then skip their delay until it loads", () => {
		const holding = written<Slot>(noHold(), services, logs, true)
		const waited = elapsed(holding, 2, true)
		expect(waited).toEqual({ _tag: "Waited", instance: 2 })
		expect(shownSlot(waited, logs)).toBe(logs)
		expect(written(waited, logs, logs, false)).toEqual(noHold())
		expect(elapsed(holding, 2, false)).toEqual(noHold())
	})

	test("a second navigation during a hold keeps the page that is on screen, under a new timer", () => {
		const holding = written<Slot>(noHold(), services, logs, true)
		const again = written(holding, logs, traces, true)
		expect(again).toEqual({ _tag: "Holding", leaving: services, instance: 3 })
		expect(startedHold(holding, again)).toBe(3)
		// The first navigation's timer no longer applies.
		expect(elapsed(again, 2, true)).toBe(again)
	})

	test("another org's page is never held on screen, and the first page has nothing to hold", () => {
		expect(written<Slot>(noHold(), services, slot(2, "org_other"), true)).toEqual(noHold())
		expect(written<Slot>(noHold(), null, logs, true)).toEqual(noHold())
		const holding: PageHold<Slot> = written<Slot>(noHold(), services, logs, true)
		expect(written(holding, logs, null, true)).toEqual(noHold())
	})
})
