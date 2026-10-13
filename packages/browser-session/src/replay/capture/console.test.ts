import { afterEach, describe, expect, it } from "vitest"
import type { SessionEvent } from "../../events/events-sink"
import { installConsoleCapture } from "./console"

describe("installConsoleCapture", () => {
	const realDebug = console.debug
	let uninstall: (() => void) | undefined
	afterEach(() => {
		uninstall?.()
		uninstall = undefined
		// After `uninstall`, which restores whatever it wrapped: the stub below.
		console.debug = realDebug
	})

	it("bounds a huge logged array before serializing it", () => {
		const events: SessionEvent[] = []
		console.debug = () => {}
		uninstall = installConsoleCapture((event) => events.push(event))
		console.debug(Array.from({ length: 1_000_000 }, (_, index) => index))

		const message = events[0]?.message ?? ""
		expect(message.startsWith("[0,1,2,")).toBe(true)
		expect(message.length).toBeLessThanOrEqual(2_001)
	})

	it("keeps a capture installed on top working when the one underneath is torn down", () => {
		console.debug = () => {}
		const inner: SessionEvent[] = []
		const outer: SessionEvent[] = []
		const stopInner = installConsoleCapture((event) => inner.push(event))
		const stopOuter = installConsoleCapture((event) => outer.push(event))
		stopInner()
		console.debug("after inner stopped")
		expect(outer.map((event) => event.message)).toEqual(["after inner stopped"])
		expect(inner).toEqual([])
		stopOuter()
	})

	it("keeps the capture underneath working when the one on top is torn down", () => {
		console.debug = () => {}
		const inner: SessionEvent[] = []
		const stopInner = installConsoleCapture((event) => inner.push(event))
		const stopOuter = installConsoleCapture(() => {})
		stopOuter()
		console.debug("after outer stopped")
		expect(inner.map((event) => event.message)).toEqual(["after outer stopped"])
		stopInner()
	})
})
