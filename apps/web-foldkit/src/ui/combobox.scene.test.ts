import * as Animation from "@foldkit/ui/animation"
import { inertHtml as ih } from "foldkit/html"
import {
	all,
	click,
	Command,
	expect,
	expectAll,
	expectOutMessage,
	first,
	given,
	keydown,
	Mount,
	role,
	scene,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, test } from "vitest"
import * as Autocomplete from "./autocomplete"
import { init, itemId, Message, MountCombobox, OutMessage, update, WaitForComboboxExit } from "./combobox"
import { chipsView } from "./combobox-view"

/** Combobox (chips, multiple) and Autocomplete: typing filters, arrows move the active option. */
const SERVICES = ["api-gateway", "checkout-svc", "payment-svc", "inventory-svc", "notification-svc"]

const chips = {
	update,
	view: withViewInputs(chipsView, {
		items: SERVICES,
		ariaLabel: "Services",
		placeholder: "Add a service",
		emptyText: "No services found.",
		toView: (parts) => ih.main([], parts),
	})(),
}

const autocomplete = {
	update,
	view: withViewInputs(Autocomplete.view, {
		items: SERVICES,
		ariaLabel: "Search services",
		placeholder: "Search services",
		emptyText: "No matches.",
		toView: ({ field, rest }) => ih.main([], [field, ...rest]),
	})(),
}

const input = (name: string) => role("combobox", { name })
const option = (name: string) => role("option", { name })
const options = all.role("option")

const opened = () => [
	Mount.resolve(MountCombobox, Message.CompletedMountCombobox()),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
]

const exited = (id: string, generation: number) => [
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation })),
	Command.resolve(
		WaitForComboboxExit({ id, generation }),
		Animation.Message.EndedAnimation({ generation }),
	),
	Mount.expectEnded(MountCombobox),
	expect(role("listbox")).toBeAbsent(),
]

describe("combobox scene (chips)", () => {
	test("the selection shows as chips and as selected options", () => {
		scene(
			chips,
			given(init("services", "multiple", { selected: ["checkout-svc", "payment-svc"], isOpen: true })),
			Mount.resolve(MountCombobox, Message.CompletedMountCombobox()),
			expectAll(all.role("button", { name: "Remove" })).toHaveCount(2),
			expect(option("checkout-svc")).toHaveAttr("aria-selected", "true"),
			expect(option("api-gateway")).toHaveAttr("aria-selected", "false"),
			expect(role("listbox")).toHaveAttr("aria-multiselectable", "true"),
		)
	})

	test("typing opens and filters the list; arrows set the active descendant; Enter toggles it", () => {
		scene(
			chips,
			given(init("services", "multiple", { selected: ["checkout-svc"] })),
			type(input("Services"), "svc"),
			...opened(),
			expectAll(options).toHaveCount(4),
			keydown(input("Services"), "ArrowDown"),
			expect(input("Services")).toHaveAttr("aria-activedescendant", itemId("services", 0)),
			expect(option("checkout-svc")).toHaveAttr("data-highlighted", ""),
			keydown(input("Services"), "ArrowDown"),
			keydown(input("Services"), "Enter"),
			expectOutMessage(OutMessage.ChangedSelection({ selected: ["checkout-svc", "payment-svc"] })),
			expect(option("payment-svc")).toHaveAttr("aria-selected", "true"),
		)
	})

	test("a chip's remove button drops it from the selection", () => {
		scene(
			chips,
			given(init("services", "multiple", { selected: ["checkout-svc", "payment-svc"] })),
			click(first(all.role("button", { name: "Remove" }))),
			expectOutMessage(OutMessage.ChangedSelection({ selected: ["payment-svc"] })),
		)
	})

	test("no match shows the empty status; Escape closes", () => {
		scene(
			chips,
			given(init("services", "multiple")),
			type(input("Services"), "zzz"),
			...opened(),
			expect(role("status")).toHaveText("No services found."),
			keydown(input("Services"), "Escape"),
			...exited("services", 2),
		)
	})
})

describe("autocomplete scene", () => {
	test("Enter on the active option fills the input and closes the list", () => {
		scene(
			autocomplete,
			given(init("search", "autocomplete")),
			type(input("Search services"), "pay"),
			...opened(),
			keydown(input("Search services"), "ArrowDown"),
			keydown(input("Search services"), "Enter"),
			expectOutMessage(OutMessage.ChangedValue({ value: "payment-svc" })),
			...exited("search", 2),
			expect(input("Search services")).toHaveValue("payment-svc"),
		)
	})

	test("a press outside closes the list", () => {
		scene(
			autocomplete,
			given(init("search", "autocomplete", { isOpen: true })),
			Mount.resolve(MountCombobox, Message.PressedOutside()),
			expect(input("Search services")).toHaveAttr("aria-expanded", "false"),
			...exited("search", 1),
		)
	})
})
