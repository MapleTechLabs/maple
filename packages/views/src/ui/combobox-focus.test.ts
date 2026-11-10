import { Effect, Fiber, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { focusLeaves } from "./combobox"

/** An element stand-in: `closest` answers whether it sits in the field (the anchor). */
class FakeElement extends EventTarget {
	constructor(private readonly isInField: boolean) {
		super()
	}
	closest(): FakeElement | null {
		return this.isInField ? this : null
	}
}

const original = globalThis.document
const originalElement = globalThis.Element
beforeEach(() => {
	Object.defineProperty(globalThis, "document", { value: new EventTarget(), configurable: true })
	Object.defineProperty(globalThis, "Element", { value: FakeElement, configurable: true })
})
afterEach(() => {
	Object.defineProperty(globalThis, "document", { value: original, configurable: true })
	Object.defineProperty(globalThis, "Element", { value: originalElement, configurable: true })
})

/** How many times the list is told to close while focus lands on each of `targets` in turn. */
const closesFor = (inList: FakeElement, targets: ReadonlyArray<FakeElement>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const seen: Array<string> = []
			const root = { contains: (node: unknown) => node === inList }
			const fiber = yield* Effect.forkChild(
				Stream.runForEach(focusLeaves(root, "[data-field]"), (message) =>
					Effect.sync(() => seen.push(message._tag)),
				),
			)
			yield* Effect.sleep(10)
			yield* Effect.forEach(targets, (target) =>
				Effect.sync(() =>
					globalThis.document.dispatchEvent(
						Object.defineProperty(new Event("focusin"), "target", { value: target }),
					),
				),
			)
			yield* Effect.sleep(10)
			yield* Fiber.interrupt(fiber)
			return seen
		}),
	)

describe("focusLeaves", () => {
	test("focus moving within the field or its list keeps the list open", async () => {
		const inList = new FakeElement(false)
		expect(await closesFor(inList, [new FakeElement(true), inList])).toEqual([])
	})

	test("Tab to a control outside the field and its list closes the list", async () => {
		expect(await closesFor(new FakeElement(false), [new FakeElement(false)])).toEqual(["PressedOutside"])
	})
})
