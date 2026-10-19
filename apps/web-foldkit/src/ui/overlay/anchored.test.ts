import { Effect, Fiber, Stream } from "effect"
import { afterEach, describe, expect, test } from "vitest"
import { strayEscapes } from "./anchored"

const original = globalThis.document
afterEach(() => {
	Object.defineProperty(globalThis, "document", { value: original, configurable: true })
})

/** Escapes `strayEscapes(root)` emits for `keys` pressed on a document whose last portal is topmost. */
const escapesFor = (root: EventTarget, portals: ReadonlyArray<EventTarget>, keys: ReadonlyArray<string>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const doc = Object.assign(new EventTarget(), { querySelectorAll: () => portals })
			Object.defineProperty(globalThis, "document", { value: doc, configurable: true })
			const seen: Array<string> = []
			const fiber = yield* Effect.forkChild(
				Stream.runForEach(strayEscapes(root), () => Effect.sync(() => seen.push("escape"))),
			)
			yield* Effect.sleep(10)
			yield* Effect.forEach(keys, (key) =>
				Effect.sync(() => doc.dispatchEvent(Object.assign(new Event("keydown"), { key }))),
			)
			yield* Effect.sleep(10)
			yield* Fiber.interrupt(fiber)
			return seen.length
		}),
	)

describe("strayEscapes", () => {
	test("an Escape with focus on the body reaches the topmost dialog; other keys do not", async () => {
		const root = new EventTarget()
		expect(await escapesFor(root, [new EventTarget(), root], ["Enter", "Escape"])).toBe(1)
	})

	test("a dialog under another portal leaves the Escape to the topmost one", async () => {
		const root = new EventTarget()
		expect(await escapesFor(root, [root, new EventTarget()], ["Escape"])).toBe(0)
	})
})
