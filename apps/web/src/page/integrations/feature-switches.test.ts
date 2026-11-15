import { describe, expect, it } from "vitest"
import {
	completedSwitches,
	initFeatureSwitches,
	settledSwitches,
	shownSwitches,
	toggledSwitches,
} from "./feature-switches"

type Switches = Readonly<{ metrics: boolean; events: boolean }>
const saved: Switches = { metrics: true, events: true }
const flipEvents = (switches: Switches): Switches => ({ ...switches, events: !switches.events })

describe("feature switches", () => {
	it("shows a toggle at once and asks to save it", () => {
		const step = toggledSwitches(initFeatureSwitches, saved, flipEvents)
		expect(step.save).toEqual({ metrics: true, events: false })
		expect(shownSwitches(step.state, saved).events).toBe(false)
	})

	it("ignores a second toggle while the first save is in flight", () => {
		const first = toggledSwitches(initFeatureSwitches, saved, flipEvents)
		const second = toggledSwitches(first.state, saved, flipEvents)
		expect(second.save).toBeNull()
		expect(shownSwitches(second.state, saved).events).toBe(false)
	})

	it("puts the switch back and keeps the reason when the save fails", () => {
		const step = toggledSwitches(initFeatureSwitches, saved, flipEvents)
		const failed = completedSwitches(step.state, "Forbidden")
		expect(shownSwitches(failed, saved).events).toBe(true)
		expect(failed.error).toBe("Forbidden")
	})

	it("keeps the new value until the status read lands, then follows the status", () => {
		const step = toggledSwitches(initFeatureSwitches, saved, flipEvents)
		const answered = completedSwitches(step.state, null)
		expect(shownSwitches(answered, saved).events).toBe(false)
		const reread: Switches = { metrics: true, events: false }
		const settled = settledSwitches(answered)
		expect(settled.draft).toBeNull()
		expect(shownSwitches(settled, reread).events).toBe(false)
	})

	it("a status read during the save does not drop the pending value", () => {
		const step = toggledSwitches(initFeatureSwitches, saved, flipEvents)
		expect(shownSwitches(settledSwitches(step.state), saved).events).toBe(false)
	})
})
