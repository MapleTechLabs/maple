import * as Animation from "@foldkit/ui/animation"
import { inertHtml as ih } from "foldkit/html"
import { Command, expect, given, hover, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { expect as assert, describe, test } from "vitest"
import { init, Message, MountHoverCard, update, view, WaitHoverDelay } from "./hover-card"

/** Hover card: opens after the pointer rests on the trigger; leaving schedules the close. */
const ID = "service"

const sceneView = withViewInputs(view, {
	toView: ({ trigger, portal }) => ih.main([], [ih.button([...trigger], ["payment-svc"]), portal]),
	toContent: () => [ih.span([], ["412 req/s"])],
})
const config = { update, view: sceneView() }
const trigger = role("button", { name: "payment-svc" })

describe("hover card scene", () => {
	test("resting on the trigger opens it after the open delay, below the trigger", () => {
		scene(
			config,
			given(init(ID)),
			hover(trigger),
			expect(text("412 req/s")).toBeAbsent(),
			Command.resolve(WaitHoverDelay, Message.ElapsedHoverDelay({ generation: 1, isOpening: true })),
			Mount.resolve(MountHoverCard, Message.CompletedMountHoverCard()),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			expect(text("412 req/s")).toExist(),
			expect(trigger).toHaveAttr("data-popup-open", ""),
		)
	})

	test("a delay overtaken by a newer pointer move is dropped", () => {
		const entered = update(init(ID), Message.EnteredTrigger({ triggerId: "service-trigger" }))
		const left = update(entered.model, Message.LeftTrigger())
		const stale = update(left.model, Message.ElapsedHoverDelay({ generation: 1, isOpening: true }))
		assert({ model: stale.model, generation: left.model.hoverGeneration }).toEqual({
			model: left.model,
			generation: 2,
		})
	})

	test("leaving the trigger closes it after the close delay, unless the pointer reaches the card", () => {
		const open = init(ID, { isOpen: true })
		const left = update(open, Message.LeftTrigger())
		assert(left.commands?.map((command) => command.name)).toEqual(["WaitHoverDelay"])
		const onCard = update(left.model, Message.EnteredCard())
		const kept = update(onCard.model, Message.ElapsedHoverDelay({ generation: 1, isOpening: false }))
		assert(kept.model).toEqual(onCard.model)
		const closed = update(left.model, Message.ElapsedHoverDelay({ generation: 1, isOpening: false }))
		assert({ isOpen: closed.model.isOpen, state: closed.model.animation.transitionState }).toEqual({
			isOpen: false,
			state: "LeaveStart",
		})
	})
})
