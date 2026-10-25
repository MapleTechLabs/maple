import type { Html, HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, Mount, role, scene } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Popover from "../../../ui/popover"
import { onScreenOr } from "../../../ui/overlay/position"
import * as QuickPick from "./quick-pick"

const items = [
	{ value: "none", label: "No severity", shortcut: "0", keywords: "none unset clear" },
	{ value: "critical", label: "Critical", shortcut: "1" },
	{ value: "high", label: "High", shortcut: "2", isDisabled: true },
]

const press = (model: QuickPick.Model, key: string) =>
	QuickPick.update(model, QuickPick.Message.PressedInputKey({ key, items }))

describe("quick pick", () => {
	test("a digit picks its row while nothing is typed; a disabled row's digit does nothing", () => {
		const model = QuickPick.init("picker")
		expect(press(model, "1").outMessage).toEqual(QuickPick.OutMessage.Picked({ value: "critical" }))
		expect(press(model, "2").outMessage).toBeUndefined()
	})

	test("typing filters by label and keywords; Enter picks the first match", () => {
		const typed = QuickPick.update(
			QuickPick.init("picker"),
			QuickPick.Message.ChangedQuery({ value: "unset" }),
		)
		expect(QuickPick.visibleOf(items, typed.model.query).map((item) => item.value)).toEqual(["none"])
		expect(press(typed.model, "Enter").outMessage).toEqual(QuickPick.OutMessage.Picked({ value: "none" }))
	})

	test("Escape closes without a pick", () => {
		expect(press(QuickPick.init("picker"), "Escape").outMessage).toEqual(QuickPick.OutMessage.Closed())
	})
})

describe("quick pick anchor", () => {
	const shown = { name: "trigger", getClientRects: () => ({ length: 1 }) }
	const hidden = { name: "trigger", getClientRects: () => ({ length: 0 }) }
	const row = { name: "row", getClientRects: () => ({ length: 1 }) }

	test("a hidden trigger anchors the popover on the row, a shown one on itself", () => {
		expect(onScreenOr(shown, () => row)?.name).toBe("trigger")
		expect(onScreenOr(hidden, () => row)?.name).toBe("row")
	})

	test("the fallback row reaches the popover's mount", () => {
		const view = (model: QuickPick.Model, h: HtmlBuilder<QuickPick.Message>): Html =>
			QuickPick.view(h, {
				model,
				items: [],
				current: null,
				placeholder: "Change status",
				hotkey: "S",
				label: "Status",
				toMessage: (message) => message,
				trigger: (attributes) => h.button([...attributes], ["Status"]),
				toView: (parts) => h.span([], parts),
				fallbackAnchorSelector: 'a[data-issue-id="iss_1"]',
			})
		scene(
			{ update: QuickPick.update, view },
			given(QuickPick.init("picker")),
			Mount.expectHas(
				Popover.MountPopover({
					id: "picker",
					align: "start",
					side: "bottom",
					sideOffset: 6,
					isBare: true,
					initialFocus: "popup",
					fallbackAnchorSelector: 'a[data-issue-id="iss_1"]',
				}),
			),
			Mount.resolve(Popover.MountPopover, Popover.Message.CompletedMountPopover()),
			expectView(role("button", { name: "Status" })).toHaveAttr("aria-expanded", "true"),
		)
	})
})
