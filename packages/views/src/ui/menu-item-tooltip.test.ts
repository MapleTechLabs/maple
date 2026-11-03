import { describe, expect, test } from "vitest"
import { init, itemTooltipTriggerId, Message, update } from "./menu"
import * as Tooltip from "./tooltip"

// A disabled item's tooltip (`<TooltipTrigger render={<div />}>` around the item).

const ID = "widget-actions"
const triggerId = itemTooltipTriggerId(ID, 3)

const entered = () => {
	const open = update(init(ID), Message.ClickedTrigger()).model
	return update(
		open,
		Message.GotItemTooltipMessage({ message: Tooltip.Message.EnteredTrigger({ triggerId }), side: "left" }),
	)
}

describe("menu item tooltip", () => {
	test("hovering the wrapper waits the open delay, then opens on the item's side", () => {
		const step = entered()
		expect(step.commands?.map((command) => command.name)).toEqual(["WaitOpenDelay"])
		const generation = step.model.itemTooltip.hoverGeneration
		const opened = update(
			step.model,
			Message.GotItemTooltipMessage({ message: Tooltip.Message.ElapsedOpenDelay({ generation }), side: "left" }),
		).model
		expect(opened.itemTooltip.isOpen).toBe(true)
		expect(opened.itemTooltip.requestedSide).toBe("left")
		expect(opened.itemTooltip.triggerId).toBe(triggerId)
	})

	test("closing the menu drops a pending or open tooltip", () => {
		const closed = update(entered().model, Message.PressedOutside()).model
		expect(closed.itemTooltip.isOpen).toBe(false)
		expect(closed.itemTooltip.triggerId).not.toBe(triggerId)
	})
})
