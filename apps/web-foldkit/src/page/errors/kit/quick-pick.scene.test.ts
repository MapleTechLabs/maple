import { describe, expect, test } from "vitest"
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
