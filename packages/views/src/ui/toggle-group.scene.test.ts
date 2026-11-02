import type { Html, HtmlBuilder } from "foldkit/html"
import { Command, click, expect, given, keydown, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import * as ToggleGroup from "./toggle-group"

const ITEMS = [
	{ value: "logs", label: "Logs" },
	{ value: "traces", label: "Traces" },
	{ value: "metrics", label: "Metrics" },
]

const view = (model: ToggleGroup.Model, h: HtmlBuilder<ToggleGroup.Message>): Html =>
	ToggleGroup.view(h, { model, toParentMessage: (message) => message, items: ITEMS, variant: "outline" })

const item = (name: string) => role("button", { name })

describe("toggle group", () => {
	test("single: pressing an item releases the previous one, pressing it again empties the group", () => {
		scene(
			{ update: ToggleGroup.update, view },
			given(ToggleGroup.init({ label: "Signals", values: ["logs"] })),
			click(item("Traces")),
			expect(item("Traces")).toHaveAttr("aria-pressed", "true"),
			expect(item("Logs")).toHaveAttr("aria-pressed", "false"),
			click(item("Traces")),
			expect(item("Traces")).toHaveAttr("aria-pressed", "false"),
		)
	})

	test("multiple: items press independently", () => {
		scene(
			{ update: ToggleGroup.update, view },
			given(ToggleGroup.init({ label: "Signals", isMultiple: true, values: ["logs"] })),
			click(item("Metrics")),
			expect(item("Logs")).toHaveAttr("aria-pressed", "true"),
			expect(item("Metrics")).toHaveAttr("aria-pressed", "true"),
			expect(item("Metrics")).toHaveAttr("data-pressed", ""),
		)
	})

	test("arrow keys move the tab stop and focus around the group, wrapping at the ends", () => {
		scene(
			{ update: ToggleGroup.update, view },
			given(ToggleGroup.init({ label: "Signals", values: [] })),
			expect(item("Logs")).toHaveAttr("tabIndex", "0"),
			keydown(item("Logs"), "ArrowLeft"),
			Command.expectExact(
				ToggleGroup.FocusItem({
					selector: '[data-slot="toggle-group"][aria-label="Signals"] > :nth-child(3)',
				}),
			),
			Command.resolve(ToggleGroup.FocusItem, ToggleGroup.Message.CompletedFocusItem()),
			expect(item("Metrics")).toHaveAttr("tabIndex", "0"),
			expect(item("Logs")).toHaveAttr("tabIndex", "-1"),
		)
	})
})
