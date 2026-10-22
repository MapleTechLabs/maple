import { describe, expect, test } from "vitest"
import { CheckFocusVisible, init, Message, update } from "./tooltip"

/** Base UI opens a tooltip on focus only when the focus is `:focus-visible`. */
const ID = "columns"
const triggerId = "columns-trigger"

describe("tooltip focus", () => {
	test("focus returned by a closing popover (not focus-visible) leaves it closed", () => {
		const focused = update(init(ID), Message.FocusedTrigger({ triggerId }))
		const checked = update(
			focused.model,
			Message.CheckedFocusVisible({ triggerId, isFocusVisible: false }),
		)
		expect({
			isOpenOnFocus: focused.model.isOpen,
			checks: focused.commands?.map((command) => command.name),
			isOpen: checked.model.isOpen,
		}).toEqual({ isOpenOnFocus: false, checks: [CheckFocusVisible.name], isOpen: false })
	})

	test("keyboard focus opens it at once on that trigger", () => {
		const focused = update(init(ID), Message.FocusedTrigger({ triggerId }))
		const checked = update(
			focused.model,
			Message.CheckedFocusVisible({ triggerId, isFocusVisible: true }),
		)
		expect({ isOpen: checked.model.isOpen, triggerId: checked.model.triggerId }).toEqual({
			isOpen: true,
			triggerId,
		})
	})
})
