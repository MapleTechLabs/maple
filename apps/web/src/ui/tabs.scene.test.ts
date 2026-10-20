import type { HtmlBuilder } from "foldkit/html"
import { click, Command, expect, given, keydown, Mount, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import { FocusTab, init, MeasureTabIndicator, Message, type Model, update } from "./tabs"
import { view } from "./tabs-view"

const program = {
	update,
	view: (model: Model, h: HtmlBuilder<Message>) =>
		view(model, { labels: ["Inbox", "Rules", "Routing"], panel: (value) => [`${value} panel`] }, h),
}
const rules = init({ idBase: 4, values: ["inbox", "rules", "routing"], selected: "rules" })

const RECT = { left: 64, right: 81, top: 4, bottom: 5, width: 62, height: 32 }
const measured = Mount.resolve(MeasureTabIndicator, Message.MeasuredIndicator({ rect: RECT }))

const tab = (name: string) => role("tab", { name })
const panel = role("tabpanel")

describe("tabs", () => {
	test("the selected tab holds the tab stop and labels its panel", () => {
		scene(
			program,
			given(rules),
			expect(tab("Rules")).toHaveAttr("aria-selected", "true"),
			expect(tab("Rules")).toHaveAttr("tabindex", "0"),
			expect(tab("Rules")).toHaveAttr("aria-controls", "base-ui-_r_7_"),
			expect(tab("Inbox")).toHaveAttr("tabindex", "-1"),
			expect(panel).toHaveText("rules panel"),
			expect(panel).toHaveAttr("aria-labelledby", "base-ui-_r_5_"),
			measured,
		)
	})

	test("clicking a tab selects it and records the activation direction", () => {
		scene(
			program,
			given(rules),
			measured,
			click(tab("Routing")),
			expect(tab("Routing")).toHaveAttr("aria-selected", "true"),
			expect(tab("Routing")).toHaveAttr("data-activation-direction", "right"),
			expect(tab("Rules")).toHaveAttr("aria-selected", "false"),
			expect(panel).toHaveText("routing panel"),
			click(tab("Inbox")),
			expect(tab("Inbox")).toHaveAttr("data-activation-direction", "left"),
			expect(panel).toHaveText("inbox panel"),
		)
	})

	test("arrow keys move focus without selecting and wrap at the ends", () => {
		scene(
			program,
			given(rules),
			measured,
			keydown(tab("Rules"), "ArrowRight"),
			Command.expectExact(FocusTab({ id: "base-ui-_r_6_" })),
			Command.resolve(FocusTab, Message.CompletedFocusTab()),
			expect(tab("Routing")).toHaveAttr("tabindex", "0"),
			expect(tab("Routing")).toHaveAttr("aria-selected", "false"),
			expect(tab("Rules")).toHaveAttr("aria-selected", "true"),
			keydown(tab("Routing"), "ArrowRight"),
			Command.resolve(FocusTab, Message.CompletedFocusTab()),
			expect(tab("Inbox")).toHaveAttr("tabindex", "0"),
			keydown(tab("Inbox"), "End"),
			Command.resolve(FocusTab, Message.CompletedFocusTab()),
			expect(tab("Routing")).toHaveAttr("tabindex", "0"),
		)
	})

	test("the indicator carries the measured rect as Base UI's CSS variables", () => {
		scene(
			program,
			given(rules),
			expect(role("presentation")).not.toHaveAttr("style"),
			measured,
			expect(role("presentation")).toHaveAttr(
				"style",
				"--active-tab-left: 64px; --active-tab-right: 81px; --active-tab-top: 4px; --active-tab-bottom: 5px; --active-tab-width: 62px; --active-tab-height: 32px;",
			),
		)
	})
})
