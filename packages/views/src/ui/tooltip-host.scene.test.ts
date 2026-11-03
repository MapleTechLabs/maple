import type { HtmlBuilder } from "foldkit/html"
import { expect, given, Mount, scene, text } from "foldkit/scene"
import { expect as assert, describe, test } from "vitest"
import * as Tooltip from "./tooltip"
import { init, Message, type Model, update, view } from "./tooltip-host"

/** The delegated tooltip: one Model serves every `tooltipTrigger` on the page. */
const ID = "host"

const entered = (model: Model, triggerId: string, text: string) =>
	update(model, Message.EnteredTrigger({ triggerId, shown: { text, isIconButton: false, side: "top" } }))

const elapsed = (model: Model) =>
	update(
		model,
		Message.GotTooltipMessage({
			message: Tooltip.Message.ElapsedOpenDelay({ generation: model.tooltip.hoverGeneration }),
		}),
	)

const mounted = Mount.resolve(Tooltip.MountTooltip, Tooltip.Message.CompletedMountTooltip())
const sceneView = (model: Model, h: HtmlBuilder<Message>) =>
	h.main([], [view(h, model, (message) => message)])

describe("tooltip host", () => {
	test("resting on a trigger waits the provider delay, then opens with that trigger's text", () => {
		const hovered = entered(init(ID), "copy", "Copy issue ID")
		assert(hovered.commands?.map((command) => command.name)).toEqual(["WaitOpenDelay"])
		const opened = elapsed(hovered.model)
		assert({ isOpen: opened.model.tooltip.isOpen, anchor: opened.model.tooltip.triggerId }).toEqual({
			isOpen: true,
			anchor: "copy",
		})
		scene(
			{ update, view: sceneView },
			given(opened.model),
			mounted,
			expect(text("Copy issue ID")).toExist(),
		)
	})

	test("moving to another trigger while open re-anchors at once with the new text", () => {
		const open = elapsed(entered(init(ID), "a", "First").model).model
		const moved = entered(open, "b", "Second")
		assert({
			isOpen: moved.model.tooltip.isOpen,
			anchor: moved.model.tooltip.triggerId,
			commands: moved.commands ?? [],
		}).toEqual({ isOpen: true, anchor: "b", commands: [] })
		scene({ update, view: sceneView }, given(moved.model), mounted, expect(text("Second")).toExist())
	})

	test("sweeping to a neighbour (leave, then enter) opens it at once while the close is warm", () => {
		const open = elapsed(entered(init(ID), "a", "First").model).model
		const left = update(open, Message.GotTooltipMessage({ message: Tooltip.Message.LeftTrigger() }))
		const next = entered(left.model, "b", "Second")
		assert({
			isOpen: next.model.tooltip.isOpen,
			anchor: next.model.tooltip.triggerId,
			waits: (next.commands ?? []).some((command) => command.name === "WaitOpenDelay"),
		}).toEqual({ isOpen: true, anchor: "b", waits: false })
		scene({ update, view: sceneView }, given(next.model), mounted, expect(text("Second")).toExist())
	})

	test("once the warm window passes, the next trigger waits the delay again", () => {
		const open = elapsed(entered(init(ID), "a", "First").model).model
		const left = update(open, Message.GotTooltipMessage({ message: Tooltip.Message.LeftTrigger() })).model
		const cooled = update(left, Message.ElapsedWarmWindow({ generation: left.warmGeneration })).model
		const next = entered(cooled, "b", "Second")
		assert({
			isOpen: next.model.tooltip.isOpen,
			commands: next.commands?.map((command) => command.name),
		}).toEqual({ isOpen: false, commands: ["WaitOpenDelay"] })
	})

	test("only the anchored trigger's text and the incoming one are kept", () => {
		const open = elapsed(entered(init(ID), "a", "First").model).model
		const second = entered(open, "b", "Second").model
		const third = entered(second, "c", "Third").model
		assert(Object.keys(third.shown).sort()).toEqual(["b", "c"])
	})

	test("the shown trigger's new text replaces the old one; other triggers' changes are dropped", () => {
		const open = elapsed(entered(init(ID), "copy", "Copy mapping").model).model
		const copied = update(open, Message.ChangedTriggerText({ triggerId: "copy", text: "Copied" })).model
		const elsewhere = update(
			copied,
			Message.ChangedTriggerText({ triggerId: "other", text: "Copied" }),
		).model
		assert({ text: elsewhere.shown["copy"]?.text, ids: Object.keys(elsewhere.shown) }).toEqual({
			text: "Copied",
			ids: ["copy"],
		})
		scene({ update, view: sceneView }, given(copied), mounted, expect(text("Copied")).toExist())
	})

	test("leaving before the delay ends drops the pending open", () => {
		const hovered = entered(init(ID), "a", "First").model
		const left = update(
			hovered,
			Message.GotTooltipMessage({ message: Tooltip.Message.LeftTrigger() }),
		).model
		const stale = update(
			left,
			Message.GotTooltipMessage({
				message: Tooltip.Message.ElapsedOpenDelay({ generation: hovered.tooltip.hoverGeneration }),
			}),
		)
		assert({ isOpen: stale.model.tooltip.isOpen, generation: left.tooltip.hoverGeneration }).toEqual({
			isOpen: false,
			generation: 2,
		})
	})
})
