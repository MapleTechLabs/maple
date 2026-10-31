import { afterEach, describe, expect, it } from "vitest"
import type { SessionEvent } from "../../events/events-sink"
import { installConsoleCapture, resetConsoleCaptureForTests } from "./console"

describe("installConsoleCapture", () => {
	const realDebug = console.debug
	let uninstall: (() => void) | undefined
	afterEach(() => {
		uninstall?.()
		uninstall = undefined
		resetConsoleCaptureForTests()
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

	it("keeps level and count but no text under maskAllText", () => {
		console.debug = () => {}
		const events: SessionEvent[] = []
		uninstall = installConsoleCapture((event) => events.push(event), { maskText: true })
		console.debug("card 4111 1111 1111 1111")
		console.debug("again")
		expect(events).toEqual([
			{ type: "console", level: "debug" },
			{ type: "console", level: "debug" },
		])
	})

	it("leaves a wrapper the app installed on top in place, and working, after teardown", () => {
		const seen: unknown[] = []
		console.debug = () => {}
		const events: SessionEvent[] = []
		const stop = installConsoleCapture((event) => events.push(event))
		const underneath = console.debug
		const appWrapper = (...args: unknown[]): void => {
			seen.push(args[0])
			underneath(...args)
		}
		console.debug = appWrapper
		stop()
		expect(console.debug).toBe(appWrapper)
		console.debug("after teardown")
		expect(seen).toEqual(["after teardown"])
		expect(events).toEqual([])
	})

	it("reuses its one wrapper across repeated starts and stops instead of stacking", () => {
		console.debug = () => {}
		const first = installConsoleCapture(() => {})
		const underneath = console.debug
		const appWrapper = (...args: unknown[]): void => underneath(...args)
		console.debug = appWrapper
		first()
		const events: SessionEvent[] = []
		for (let i = 0; i < 20; i++) installConsoleCapture((event) => events.push(event))()
		uninstall = installConsoleCapture((event) => events.push(event))
		expect(console.debug).toBe(appWrapper)
		console.debug("once")
		expect(events.map((event) => event.message)).toEqual(["once"])
	})

	it("never runs a getter or toJSON of a logged object, and survives a throwing Proxy", () => {
		console.debug = () => {}
		const events: SessionEvent[] = []
		uninstall = installConsoleCapture((event) => events.push(event))
		let sideEffects = 0
		const store = {
			id: 7,
			get expensive() {
				sideEffects++
				return "computed"
			},
			toJSON() {
				sideEffects++
				return "serialized"
			},
		}
		const hostile = new Proxy(
			{},
			{
				ownKeys: () => {
					throw new Error("trap")
				},
			},
		)
		console.debug(store, hostile, "tail")
		expect(sideEffects).toBe(0)
		expect(events[0]?.message).toBe('{"id":7,"expensive":"[Getter]","toJSON":[Function]} {} tail')
	})

	it("cuts a long line without splitting an emoji", () => {
		console.debug = () => {}
		const events: SessionEvent[] = []
		uninstall = installConsoleCapture((event) => events.push(event))
		console.debug(`${"a".repeat(1_999)}😀😀`)
		const message = events[0]?.message ?? ""
		expect(message).toBe(`${"a".repeat(1_999)}…`)
	})
})
