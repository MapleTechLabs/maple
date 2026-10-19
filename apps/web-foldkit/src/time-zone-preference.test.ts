import { Effect, Fiber, Stream } from "effect"
import { describe, expect, test, vi } from "vitest"

// The root's listeners target `window` (an EventTarget is all they need here).
vi.hoisted(() => Object.assign(globalThis, { window: new EventTarget() }))

const { timeZonePreferenceChanges } = await import("./subscription")
const { TIME_ZONE_PREFERENCE_EVENT, TIMEZONE_STORAGE_KEY } = await import("./platform/time-zone")

const storageEvent = (key: string) => Object.assign(new Event("storage"), { key })

const firstTwo = () => Effect.runFork(Stream.runCollect(Stream.take(timeZonePreferenceChanges, 2)))

describe("time zone preference changes", () => {
	test("another tab's write of the key and this tab's pick both re-read the zone", async () => {
		const fiber = firstTwo()
		// Re-sent until the listeners attached.
		const timer = setInterval(() => {
			window.dispatchEvent(storageEvent("maple.other"))
			window.dispatchEvent(storageEvent(TIMEZONE_STORAGE_KEY))
			window.dispatchEvent(new Event(TIME_ZONE_PREFERENCE_EVENT))
		}, 10)
		const messages = await Effect.runPromise(Fiber.join(fiber)).finally(() => clearInterval(timer))
		expect(messages.map((message) => message._tag)).toEqual(["ChangedTimeZonePreference", "ChangedTimeZonePreference"])
	})
})
