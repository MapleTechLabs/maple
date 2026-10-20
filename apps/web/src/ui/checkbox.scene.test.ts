import type { Html, HtmlBuilder } from "foldkit/html"
import { click, expect, given, keydown, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import * as Checkbox from "./checkbox"
import { label } from "./label"

const viewWith =
	(inputs: { isIndeterminate?: boolean; isDisabled?: boolean } = {}) =>
	(model: Checkbox.Model, h: HtmlBuilder<Checkbox.Message>): Html =>
		label(h, { attributes: [h.Id(Checkbox.labelId("cb-input"))] }, [
			...Checkbox.view(h, {
				model,
				toParentMessage: (message) => message,
				id: "cb",
				inputId: "cb-input",
				...inputs,
			}),
			" Notify me",
		])

// Base UI names the box through the wrapping label (`aria-labelledby`), leading space included.
const box = role("checkbox", { name: /Notify me/ })

describe("checkbox", () => {
	test("a click checks and unchecks it, mirrored in aria-checked and data-state", () => {
		scene(
			{ update: Checkbox.update, view: viewWith() },
			given(Checkbox.init()),
			expect(box).toHaveAttr("aria-checked", "false"),
			expect(box).toHaveAttr("data-unchecked", ""),
			click(box),
			expect(box).toHaveAttr("aria-checked", "true"),
			expect(box).toHaveAttr("data-checked", ""),
			expect(box).not.toHaveAttr("data-unchecked"),
			click(box),
			expect(box).toHaveAttr("aria-checked", "false"),
		)
	})

	test("Space toggles it from the keyboard", () => {
		scene(
			{ update: Checkbox.update, view: viewWith() },
			given(Checkbox.init(true)),
			keydown(box, " "),
			expect(box).toHaveAttr("aria-checked", "false"),
		)
	})

	test("indeterminate reads as mixed whatever the checked state", () => {
		scene(
			{ update: Checkbox.update, view: viewWith({ isIndeterminate: true }) },
			given(Checkbox.init()),
			expect(box).toHaveAttr("aria-checked", "mixed"),
			expect(box).toHaveAttr("data-indeterminate", ""),
			click(box),
			expect(box).toHaveAttr("aria-checked", "mixed"),
		)
	})

	test("a disabled checkbox leaves the tab order and has no click handler", () => {
		scene(
			{ update: Checkbox.update, view: viewWith({ isDisabled: true }) },
			given(Checkbox.init()),
			expect(box).toHaveAttr("aria-disabled", "true"),
			expect(box).toHaveAttr("tabIndex", "-1"),
			expect(box).not.toHaveHandler("click"),
		)
	})
})
