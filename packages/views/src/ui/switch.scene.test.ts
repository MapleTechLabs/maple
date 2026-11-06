import type { Html, HtmlBuilder } from "foldkit/html"
import {
	click,
	expect,
	expectHandled,
	expectIgnored,
	given,
	keydown,
	role,
	scene,
	selector,
} from "foldkit/scene"
import { describe, test } from "vitest"
import { label } from "./label"
import * as Switch from "./switch"

const viewWith =
	(isDisabled = false) =>
	(model: Switch.Model, h: HtmlBuilder<Switch.Message>): Html =>
		label(h, { attributes: [h.Id(Switch.labelId("sw-input"))] }, [
			...Switch.view(h, {
				model,
				toParentMessage: (message) => message,
				id: "sw",
				inputId: "sw-input",
				isDisabled,
			}),
			" Live tail",
		])

const toggle = role("switch", { name: /Live tail/ })
const thumb = selector('[data-slot="switch-thumb"]')

describe("switch", () => {
	test("a click turns it on and off; the thumb mirrors the state", () => {
		scene(
			{ update: Switch.update, view: viewWith() },
			given(Switch.init()),
			expect(toggle).toHaveAttr("aria-checked", "false"),
			expect(thumb).toHaveAttr("data-unchecked", ""),
			click(toggle),
			expect(toggle).toHaveAttr("aria-checked", "true"),
			expect(toggle).toHaveAttr("data-checked", ""),
			expect(thumb).toHaveAttr("data-checked", ""),
			click(toggle),
			expect(toggle).toHaveAttr("aria-checked", "false"),
		)
	})

	test("Space toggles it from the keyboard, other keys do not", () => {
		scene(
			{ update: Switch.update, view: viewWith() },
			given(Switch.init(true)),
			keydown(toggle, "Enter"),
			expectIgnored(),
			expect(toggle).toHaveAttr("aria-checked", "true"),
			keydown(toggle, " "),
			expectHandled(),
			expect(toggle).toHaveAttr("aria-checked", "false"),
		)
	})

	test("a disabled switch is marked on root and thumb and has no click handler", () => {
		scene(
			{ update: Switch.update, view: viewWith(true) },
			given(Switch.init()),
			expect(toggle).toHaveAttr("aria-disabled", "true"),
			expect(thumb).toHaveAttr("data-disabled", ""),
			expect(toggle).not.toHaveHandler("click"),
		)
	})
})
