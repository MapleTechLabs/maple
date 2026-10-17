import type { Html, HtmlBuilder } from "foldkit/html"
import { click, expect, given, keydown, role, scene, selector, type } from "foldkit/scene"
import { describe, test } from "vitest"
import * as Combobox from "./combobox"

const SERVICES = ["api-gateway", "checkout-svc", "payment-svc"]

const config = (model: Combobox.Model) => ({
	model,
	toParentMessage: (message: Combobox.Message) => message,
	id: "svc",
	label: "Service",
	placeholder: "Pick a service",
	emptyText: "No services found.",
})

const singleView = (model: Combobox.Model, h: HtmlBuilder<Combobox.Message>): Html =>
	h.div([], Combobox.view(h, config(model)))

const chipsView = (model: Combobox.Model, h: HtmlBuilder<Combobox.Message>): Html =>
	h.div([], Combobox.chipsView(h, config(model)))

const input = role("combobox", { name: "Service" })
const listbox = role("listbox")
const option = (name: string) => role("option", { name })

describe("combobox", () => {
	test("typing opens the list filtered to the query", () => {
		scene(
			{ update: Combobox.update, view: singleView },
			given(Combobox.init({ mode: "single", items: SERVICES, selected: ["payment-svc"] })),
			expect(input).toHaveValue("payment-svc"),
			expect(listbox).toBeAbsent(),
			type(input, "check"),
			expect(input).toHaveAttr("aria-expanded", "true"),
			expect(option("checkout-svc")).toExist(),
			expect(option("api-gateway")).toBeAbsent(),
		)
	})

	test("a query with no match shows the empty text", () => {
		scene(
			{ update: Combobox.update, view: singleView },
			given(Combobox.init({ mode: "single", items: SERVICES })),
			type(input, "zzz"),
			expect(selector('[data-slot="combobox-empty"]')).toHaveText("No services found."),
		)
	})

	test("picking an item selects it, closes the list and fills the input", () => {
		scene(
			{ update: Combobox.update, view: singleView },
			given(Combobox.init({ mode: "single", items: SERVICES, selected: ["payment-svc"] })),
			click(role("button")),
			expect(option("payment-svc")).toHaveAttr("aria-selected", "true"),
			click(option("api-gateway")),
			expect(listbox).toBeAbsent(),
			expect(input).toHaveValue("api-gateway"),
			expect(selector("#svc-hidden-input")).toHaveValue("api-gateway"),
		)
	})

	test("Escape closes the list and restores the selected value", () => {
		scene(
			{ update: Combobox.update, view: singleView },
			given(Combobox.init({ mode: "single", items: SERVICES, selected: ["payment-svc"] })),
			type(input, "api"),
			keydown(input, "ArrowDown"),
			expect(option("api-gateway")).toHaveAttr("data-highlighted", ""),
			keydown(input, "Escape"),
			expect(listbox).toBeAbsent(),
			expect(input).toHaveValue("payment-svc"),
		)
	})
})

describe("combobox chips (multiple)", () => {
	const initial = Combobox.init({ mode: "multiple", items: SERVICES, selected: ["checkout-svc"] })

	test("Enter on a highlighted item adds a chip and keeps the list open", () => {
		scene(
			{ update: Combobox.update, view: chipsView },
			given(initial),
			keydown(input, "ArrowDown"),
			keydown(input, "Enter"),
			expect(selector('[title="api-gateway"]')).toExist(),
			expect(listbox).toExist(),
			expect(input).toHaveValue(""),
		)
	})

	test("a chip's remove button and Backspace on an empty input drop chips", () => {
		scene(
			{ update: Combobox.update, view: chipsView },
			given(
				Combobox.init({
					mode: "multiple",
					items: SERVICES,
					selected: ["checkout-svc", "payment-svc"],
				}),
			),
			click(role("button", { name: "Remove" })),
			expect(selector('[title="checkout-svc"]')).toBeAbsent(),
			keydown(input, "Backspace"),
			expect(selector('[data-slot="combobox-chip"]')).toBeAbsent(),
		)
	})
})
