import type { Html, HtmlBuilder } from "foldkit/html"
import { Command, click, expect, given, keydown, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import { label } from "./label"
import * as RadioGroup from "./radio-group"

const ITEMS: ReadonlyArray<RadioGroup.RadioItem> = [
	{ value: "p50", id: "r-p50", inputId: "r-p50-input" },
	{ value: "p95", id: "r-p95", inputId: "r-p95-input" },
	{ value: "max", id: "r-max", inputId: "r-max-input", isDisabled: true },
	{ value: "p99", id: "r-p99", inputId: "r-p99-input" },
]

const view = (model: RadioGroup.Model, h: HtmlBuilder<RadioGroup.Message>): Html => {
	const config = { model, toParentMessage: (message: RadioGroup.Message) => message, items: ITEMS }
	return RadioGroup.radioGroup(
		h,
		{ label: "Percentile" },
		ITEMS.map((item) =>
			label(h, { attributes: [h.Id(RadioGroup.labelId(item.inputId))] }, [
				...RadioGroup.radio(h, config, item.value),
				` ${item.value}`,
			]),
		),
	)
}

const radio = (value: string) => role("radio", { name: new RegExp(value) })

describe("radio group", () => {
	test("clicking a radio checks it and unchecks the previous one", () => {
		scene(
			{ update: RadioGroup.update, view },
			given(RadioGroup.init("p95")),
			expect(role("radiogroup", { name: "Percentile" })).toExist(),
			expect(radio("p95")).toHaveAttr("aria-checked", "true"),
			click(radio("p50")),
			expect(radio("p50")).toHaveAttr("aria-checked", "true"),
			expect(radio("p50")).toHaveAttr("data-composite-item-active", ""),
			expect(radio("p95")).toHaveAttr("aria-checked", "false"),
		)
	})

	test("arrow keys check the next enabled radio, skipping disabled ones, and move focus", () => {
		scene(
			{ update: RadioGroup.update, view },
			given(RadioGroup.init("p95")),
			keydown(radio("p95"), "ArrowRight"),
			Command.expectExact(RadioGroup.FocusRadio({ id: "r-p99" })),
			Command.resolve(RadioGroup.FocusRadio, RadioGroup.Message.CompletedFocusRadio()),
			expect(radio("p99")).toHaveAttr("aria-checked", "true"),
			keydown(radio("p99"), "ArrowRight"),
			Command.resolve(RadioGroup.FocusRadio, RadioGroup.Message.CompletedFocusRadio()),
			expect(radio("p50")).toHaveAttr("aria-checked", "true"),
		)
	})

	test("a disabled radio cannot be checked", () => {
		scene(
			{ update: RadioGroup.update, view },
			given(RadioGroup.init("p95")),
			expect(radio("max")).toHaveAttr("aria-disabled", "true"),
			expect(radio("max")).not.toHaveHandler("click"),
		)
	})
})
