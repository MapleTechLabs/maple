import { inertHtml as ih } from "foldkit/html"
import { expect, given, keydown, Mount, role, scene, withViewInputs } from "foldkit/scene"
import { expect as assert, describe, test } from "vitest"
import { init, Message, MountResizeGroup, resize, update, view } from "./resizable"

/** Resizable panels: a drag moves the boundary by the dragged percent; arrows move it by 5. */
const ID = "waterfall"

const sceneView = withViewInputs(view, {
	withHandle: [true],
	toPanels: () => [[ih.div([], ["Waterfall"])], [ih.div([], ["Span details"])]],
})
const config = { update, view: sceneView() }
const handle = role("separator")

describe("resizable scene", () => {
	test("a drag moves the boundary from where it started, and the handle is active until release", () => {
		scene(
			config,
			given(init(ID, "horizontal", [40, 60])),
			expect(handle).toHaveAttr("aria-valuenow", "40"),
			Mount.resolve(MountResizeGroup, Message.StartedDrag({ handleIndex: 0 })),
			expect(handle).toHaveAttr("data-separator", "active"),
		)
		// The Mount's later events: each move reports the offset from the press, not from the last move.
		const started = update(
			init(ID, "horizontal", [40, 60]),
			Message.StartedDrag({ handleIndex: 0 }),
		).model
		const moved = update(started, Message.Dragged({ deltaPercent: 12.5 })).model
		const back = update(moved, Message.Dragged({ deltaPercent: -15 })).model
		assert([moved.layout, back.layout]).toEqual([
			[52.5, 47.5],
			[25, 75],
		])
		scene(
			config,
			given(update(back, Message.EndedDrag()).model),
			Mount.resolve(MountResizeGroup, Message.EndedDrag()),
			expect(handle).toHaveAttr("aria-valuenow", "25"),
			expect(handle).toHaveAttr("data-separator", "inactive"),
		)
	})

	test("arrow keys move the boundary by 5 along the group's axis; End and Home reach the ends", () => {
		scene(
			config,
			given(init(ID, "horizontal", [40, 60])),
			Mount.resolve(MountResizeGroup, Message.EndedDrag()),
			keydown(handle, "ArrowRight"),
			expect(handle).toHaveAttr("aria-valuenow", "45"),
			keydown(handle, "ArrowUp"),
			expect(handle).toHaveAttr("aria-valuenow", "45"),
			keydown(handle, "End"),
			expect(handle).toHaveAttr("aria-valuenow", "100"),
			keydown(handle, "Home"),
			expect(handle).toHaveAttr("aria-valuenow", "0"),
		)
	})

	test("a resize stays within the pair and keeps three decimals, leaving other panels alone", () => {
		assert(resize([20, 30, 50], 1, 100)).toEqual([20, 80, 0])
		assert(resize([50, 50], 0, 100 / 3)).toEqual([83.333, 16.667])
		const drag = update(init(ID, "vertical", [50, 50]), Message.Dragged({ deltaPercent: 10 }))
		assert(drag.model.layout).toEqual([50, 50])
	})
})
