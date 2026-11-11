import { Effect, Exit, Scope } from "effect"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { containEscape, keepFocusOnPress, lockBodyScroll } from "./portal"

/** A body stand-in: the scroll lock only reads `style.overflow` and `dataset`. */
const fakeBody = () => ({ style: { overflow: "" }, dataset: {} })

/** An element stand-in that is its own press target: `closest` finds a control only when it is one. */
class FakeElement extends EventTarget {
	constructor(private readonly isControl: boolean) {
		super()
	}
	closest(): FakeElement | null {
		return this.isControl ? this : null
	}
}

const original = globalThis.document
const originalElement = globalThis.Element
beforeEach(() => {
	Object.defineProperty(globalThis, "document", { value: { body: fakeBody() }, configurable: true })
	Object.defineProperty(globalThis, "Element", { value: FakeElement, configurable: true })
})
afterEach(() => {
	Object.defineProperty(globalThis, "document", { value: original, configurable: true })
	Object.defineProperty(globalThis, "Element", { value: originalElement, configurable: true })
})

const overflow = () => globalThis.document.body.style.overflow

describe("lockBodyScroll", () => {
	test("a menu closing after its confirm dialog opened leaves the body locked until the dialog closes", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const menu = yield* Scope.make()
				const dialog = yield* Scope.make()
				yield* Scope.provide(lockBodyScroll, menu)
				yield* Scope.provide(lockBodyScroll, dialog)
				yield* Scope.close(menu, Exit.void)
				const whileDialog = overflow()
				yield* Scope.close(dialog, Exit.void)
				expect({ whileDialog, after: overflow() }).toEqual({ whileDialog: "hidden", after: "" })
			}),
		))
})

describe("containEscape", () => {
	test("Escape stops at the container; other keys keep bubbling", () =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const container = new EventTarget()
					yield* containEscape(container)
					const escape = Object.assign(new Event("keydown"), { key: "Escape" })
					const enter = Object.assign(new Event("keydown"), { key: "Enter" })
					container.dispatchEvent(escape)
					container.dispatchEvent(enter)
					// oxlint-disable-next-line typescript/no-deprecated -- cancelBubble is the observable flag stopPropagation sets.
					expect({ escape: escape.cancelBubble, enter: enter.cancelBubble }).toEqual({
						escape: true,
						enter: false,
					})
				}),
			),
		))
})

describe("keepFocusOnPress", () => {
	/** Whether a mouse press on `target` still moves focus (its default) with the popup holding it. */
	const pressMovesFocus = (target: FakeElement) =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* keepFocusOnPress(target)
					const press = new Event("mousedown", { cancelable: true })
					target.dispatchEvent(press)
					return !press.defaultPrevented
				}),
			),
		)

	test("a press on a list option leaves focus in the input; a press on a control still takes it", async () => {
		expect({
			option: await pressMovesFocus(new FakeElement(false)),
			control: await pressMovesFocus(new FakeElement(true)),
		}).toEqual({ option: false, control: true })
	})
})
