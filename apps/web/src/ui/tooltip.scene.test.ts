import * as Animation from "@foldkit/ui/animation"
import { inertHtml as ih } from "foldkit/html"
import { Command, expect, given, hover, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { expect as assert, describe, test } from "vitest"
import { init, Message, MountTooltip, update, view, WaitOpenDelay } from "./tooltip"

/** Tooltip: opens after the open delay, closes at once when the pointer leaves. */
const ID = "refreshed"

const sceneView = withViewInputs(view, {
	toView: ({ trigger, portal }) =>
		ih.main([], [ih.button([...trigger()], ["Hover target"]), ...(portal === null ? [] : [portal])]),
	toContent: () => ["Last refreshed 2 minutes ago"],
})
const config = { update, view: sceneView() }
const trigger = role("button", { name: "Hover target" })
const label = text("Last refreshed 2 minutes ago")

describe("tooltip scene", () => {
	test("resting on the trigger opens it only after the open delay", () => {
		scene(
			config,
			given(init(ID)),
			hover(trigger),
			expect(label).toBeAbsent(),
			Command.resolve(WaitOpenDelay, Message.ElapsedOpenDelay({ generation: 1 })),
			Mount.resolve(MountTooltip, Message.CompletedMountTooltip()),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			expect(label).toExist(),
			expect(trigger).toHaveAttr("data-popup-open", ""),
		)
	})

	test("leaving before the delay drops the pending open; leaving an open one closes it at once", () => {
		const entered = update(init(ID), Message.EnteredTrigger({ triggerId: "refreshed-trigger" }))
		const left = update(entered.model, Message.LeftTrigger())
		const late = update(left.model, Message.ElapsedOpenDelay({ generation: 1 }))
		assert(late.model.isOpen).toBe(false)
		const closed = update(init(ID, { isOpen: true }), Message.LeftTrigger())
		assert({
			isOpen: closed.model.isOpen,
			delays: closed.commands?.filter((c) => c.name === WaitOpenDelay.name),
		}).toEqual({
			isOpen: false,
			delays: [],
		})
	})

	test("pressing the trigger starts closing an open tooltip", () => {
		const pressed = update(init(ID, { isOpen: true }), Message.PressedTrigger())
		assert(pressed.model.isOpen).toBe(false)
		scene(
			config,
			given(pressed.model),
			Mount.resolve(MountTooltip, Message.CompletedMountTooltip()),
			expect(role("presentation")).toHaveAttr("data-closed", ""),
			expect(label).toExist(),
		)
	})

	test("moving to another trigger of an open tooltip re-anchors it at once", () => {
		const moved = update(init(ID, { isOpen: true }), Message.EnteredTrigger({ triggerId: "rail-logs" }))
		assert({
			isOpen: moved.model.isOpen,
			triggerId: moved.model.triggerId,
			commands: moved.commands,
		}).toEqual({
			isOpen: true,
			triggerId: "rail-logs",
			commands: undefined,
		})
	})
})
