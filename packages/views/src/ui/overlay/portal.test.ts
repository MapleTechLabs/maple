import { Effect, Exit, Scope } from "effect"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { containEscape, lockBodyScroll } from "./portal"

/** A body stand-in: the scroll lock only reads `style.overflow` and `dataset`. */
const fakeBody = () => ({ style: { overflow: "" }, dataset: {} })

const original = globalThis.document
beforeEach(() => {
	Object.defineProperty(globalThis, "document", { value: { body: fakeBody() }, configurable: true })
})
afterEach(() => {
	Object.defineProperty(globalThis, "document", { value: original, configurable: true })
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
					expect({ escape: escape.cancelBubble, enter: enter.cancelBubble }).toEqual({
						escape: true,
						enter: false,
					})
				}),
			),
		))
})
