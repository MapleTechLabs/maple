import { type HtmlBuilder, inertHtml as ih } from "foldkit/html"
import { all, Command, expect, expectAll, given, keydown, Mount, role, scene, selector } from "foldkit/scene"
import { expect as assert, describe, test } from "vitest"
import {
	add,
	init,
	type Message,
	Message as ToastMessage,
	type Model,
	MeasureToast,
	PortalToasts,
	update,
	WaitForToastExit,
} from "./toast"
import { regions } from "./toast-view"

/** Toasts: both Notifications regions, the newest toast first, timeouts and the exit transition. */
const view = (model: Model, h: HtmlBuilder<Message>) =>
	ih.main(
		[],
		regions(h, model, (message: Message) => message),
	)
const config = { update, view }

const toast = (name: string) => role("dialog", { name })
const portalsMounted = () => [
	Mount.resolve(PortalToasts, ToastMessage.CompletedPortalToasts()),
	Mount.resolve(PortalToasts, ToastMessage.CompletedPortalToasts()),
]
const measured = () =>
	Mount.resolve(MeasureToast, ToastMessage.MeasuredToast({ toastId: "toasts-0", height: 88 }))

const added = (timeoutMs: number) =>
	add(init("toasts"), { type: "success", title: "Schema applied", description: "14 tables.", timeoutMs })
const entered = (timeoutMs: number) =>
	update(added(timeoutMs).model, ToastMessage.CompletedToastEnter({ toastId: "toasts-0" })).model

const commandNames = (result: { commands?: ReadonlyArray<{ name: string }> }) =>
	result.commands?.map((command) => command.name) ?? []

describe("toast scene", () => {
	test("an empty page still has both Notifications regions", () => {
		scene(
			config,
			given(init("toasts")),
			...portalsMounted(),
			expectAll(all.role("region", { name: "Notifications" })).toHaveCount(2),
		)
	})

	test("add starts the enter transition and, with a timeout, its timer", () => {
		assert(commandNames(added(5000))).toContain("WaitToastTimeout")
		assert(commandNames(added(0))).toEqual(["WaitForToastPaint"])
		scene(
			config,
			given(added(0).model),
			...portalsMounted(),
			measured(),
			expect(toast("Schema applied")).toHaveAttr("data-starting-style", ""),
			expect(toast("Schema applied")).toHaveAttr("data-type", "success"),
			expect(selector('[data-slot="toast-viewport"]')).toHaveStyle("--toast-frontmost-height", "88px"),
		)
	})

	test("the timeout closes it with its exit transition, after which it leaves", () => {
		const closing = update(entered(5000), ToastMessage.ElapsedToastTimeout({ toastId: "toasts-0" }))
		assert(commandNames(closing)).toEqual(["WaitForToastExit"])
		scene(
			config,
			given(closing.model),
			...portalsMounted(),
			measured(),
			expect(toast("Schema applied")).toHaveAttr("data-ending-style", ""),
		)
		const removed = update(closing.model, ToastMessage.EndedToastTransition({ toastId: "toasts-0" }))
		assert(removed.model.toasts).toEqual([])
	})

	test("a hovered region holds the timeout instead of closing the toast", () => {
		const hovered = update(entered(5000), ToastMessage.EnteredViewport()).model
		const elapsed = update(hovered, ToastMessage.ElapsedToastTimeout({ toastId: "toasts-0" }))
		assert(elapsed.model.toasts.map((item) => item.phase)).toEqual(["Open"])
		assert(commandNames(elapsed)).toEqual(["WaitToastTimeout"])
		scene(
			config,
			given(hovered),
			...portalsMounted(),
			measured(),
			expect(toast("Schema applied")).toHaveAttr("data-expanded", ""),
		)
	})

	test("Escape on a toast closes it", () => {
		scene(
			config,
			given(entered(0)),
			...portalsMounted(),
			measured(),
			keydown(toast("Schema applied"), "Escape"),
			Command.resolve(WaitForToastExit, ToastMessage.EndedToastTransition({ toastId: "toasts-0" })),
			Mount.expectEnded(MeasureToast),
			expect(toast("Schema applied")).toBeAbsent(),
		)
	})
})
