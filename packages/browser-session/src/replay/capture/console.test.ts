import { afterEach, describe, expect, it } from "vitest"
import type { SessionEvent } from "../../events/events-sink"
import { installConsoleCapture } from "./console"

describe("installConsoleCapture", () => {
	let uninstall: (() => void) | undefined
	afterEach(() => uninstall?.())

	it("bounds a huge logged array before serializing it", () => {
		const events: SessionEvent[] = []
		const realDebug = console.debug
		console.debug = () => {}
		uninstall = installConsoleCapture((event) => events.push(event))
		console.debug(Array.from({ length: 1_000_000 }, (_, index) => index))
		uninstall()
		uninstall = undefined
		console.debug = realDebug

		const message = events[0]?.message ?? ""
		expect(message.startsWith("[0,1,2,")).toBe(true)
		expect(message.length).toBeLessThanOrEqual(2_001)
	})
})
