import { Effect, Fiber, Stream } from "effect"
import { afterEach, describe, expect, test } from "vitest"
import { strayEscapes } from "./anchored"

const original = globalThis.document
afterEach(() => {
	Object.defineProperty(globalThis, "document", { value: original, configurable: true })
})

/** Escapes `strayEscapes(root)` emits for `keys` pressed on a document whose last portal is topmost. */
const escapesFor = (root: object, portals: ReadonlyArray<object>, keys: ReadonlyArray<string>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const doc = Object.assign(new EventTarget(), { querySelectorAll: () => portals })
			Object.defineProperty(globalThis, "document", { value: doc, configurable: true })
			const seen: Array<string> = []
			const fiber = yield* Effect.forkChild(
				Stream.runForEach(strayEscapes(root), () => Effect.sync(() => seen.push("escape"))),
			)
			yield* Effect.sleep(1)
			yield* Effect.forEach(keys, (key) =>
				Effect.sync(() => doc.dispatchEvent(Object.assign(new Event("keydown"), { key }))),
			)
			yield* Effect.sleep(1)
			yield* Fiber.interrupt(fiber)
			return seen.length
		}),
	)

describe("strayEscapes", () => {
	test("an Escape with focus on the body reaches the topmost dialog; other keys do not", async () => {
		const root = {}
		expect(await escapesFor(root, [{}, root], ["Enter", "Escape"])).toBe(1)
	})

	test("a dialog under another portal leaves the Escape to the topmost one", async () => {
		const root = {}
		expect(await escapesFor(root, [root, {}], ["Escape"])).toBe(0)
	})
})
