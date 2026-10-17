import type { Html, HtmlBuilder } from "foldkit/html"
import { click, expect, given, hover, keydown, role, scene, selector } from "foldkit/scene"
import { describe, test } from "vitest"
import * as Select from "./select"

const OPTIONS: ReadonlyArray<Select.SelectOption> = [
	{ value: "production", label: "Production" },
	{ value: "staging", label: "Staging" },
	{ value: "development", label: "Development" },
]

const view = (model: Select.Model, h: HtmlBuilder<Select.Message>): Html =>
	h.div(
		[],
		Select.view(h, {
			model,
			toParentMessage: (message) => message,
			id: "env",
			label: "Environment",
			entries: [
				{ _tag: "Group", label: "Deployed", labelId: "env-group", options: OPTIONS.slice(0, 2) },
				{ _tag: "Separator" },
				{ _tag: "Option", option: OPTIONS[2] ?? { value: "development", label: "Development" } },
			],
		}),
	)

const initial = Select.init({ values: OPTIONS.map((option) => option.value), value: "staging" })
const trigger = role("combobox", { name: "Environment" })
const listbox = role("listbox")
const option = (name: string) => role("option", { name })
const hiddenInput = selector("#env-hidden-input")

describe("select", () => {
	test("clicking the trigger opens the list with the selected option highlighted", () => {
		scene(
			{ update: Select.update, view },
			given(initial),
			expect(trigger).toHaveAttr("aria-expanded", "false"),
			expect(listbox).toBeAbsent(),
			click(trigger),
			expect(trigger).toHaveAttr("aria-expanded", "true"),
			expect(trigger).toHaveAttr("data-popup-open", ""),
			expect(listbox).toExist(),
			expect(option("Staging")).toHaveAttr("aria-selected", "true"),
			expect(option("Staging")).toHaveAttr("data-highlighted", ""),
		)
	})

	test("clicking an option selects it and closes the list", () => {
		scene(
			{ update: Select.update, view },
			given(initial),
			click(trigger),
			hover(option("Production")),
			expect(option("Production")).toHaveAttr("data-highlighted", ""),
			click(option("Production")),
			expect(listbox).toBeAbsent(),
			expect(trigger).toContainText("Production"),
			expect(hiddenInput).toHaveValue("production"),
		)
	})

	test("arrow keys open the list and move the highlight, Enter selects", () => {
		scene(
			{ update: Select.update, view },
			given(initial),
			keydown(trigger, "ArrowDown"),
			expect(listbox).toExist(),
			keydown(trigger, "ArrowDown"),
			expect(option("Development")).toHaveAttr("data-highlighted", ""),
			keydown(trigger, "Enter"),
			expect(listbox).toBeAbsent(),
			expect(trigger).toContainText("Development"),
		)
	})

	test("Escape closes the list and keeps the value", () => {
		scene(
			{ update: Select.update, view },
			given(initial),
			click(trigger),
			keydown(trigger, "ArrowUp"),
			keydown(trigger, "Escape"),
			expect(listbox).toBeAbsent(),
			expect(trigger).toContainText("Staging"),
		)
	})
})
