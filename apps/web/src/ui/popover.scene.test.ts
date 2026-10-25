import * as Animation from "@foldkit/ui/animation"
import { inertHtml as ih } from "foldkit/html"
import {
	click,
	Command,
	expect,
	given,
	keydown,
	Mount,
	role,
	scene,
	selector,
	withViewInputs,
} from "foldkit/scene"
import { describe, test } from "vitest"
import {
	init,
	Message,
	MountPopover,
	popoverDescription,
	popoverTitle,
	update,
	view,
	WaitForPopoverExit,
} from "./popover"

/** Popover through its view: the trigger toggles it; Escape, an outside press and Close close it. */
const ID = "share"

const sceneView = withViewInputs(view, {
	toView: ({ trigger, withTrigger }) => ih.main([], withTrigger(ih.button([...trigger], ["Share"]))),
	toContent: (close) => [
		popoverTitle(ih, ID, "Share this view"),
		popoverDescription(ih, ID, "Same filters for everyone."),
		ih.button([...close], ["Done"]),
	],
})
const config = { update, view: sceneView() }

const popup = role("dialog", { name: "Share this view" })
const trigger = role("button", { name: "Share" })
const portal = selector("[data-base-ui-portal]")

const paint = (generation: number) =>
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation }))

/** The exit transition, then the portal (and its Mount) leave. */
const exited = (generation: number) => [
	expect(popup).toHaveAttr("data-closed", ""),
	paint(generation),
	Command.resolve(
		WaitForPopoverExit({ id: ID, generation }),
		Animation.Message.EndedAnimation({ generation }),
	),
	Mount.expectEnded(MountPopover),
	expect(popup).toBeAbsent(),
]

describe("popover scene", () => {
	test("the trigger opens it below, labelled and described, with focus guards around the trigger", () => {
		scene(
			config,
			given(init(ID)),
			expect(popup).toBeAbsent(),
			click(trigger),
			Mount.resolve(MountPopover, Message.CompletedMountPopover()),
			paint(1),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			expect(popup).toHaveAttr("data-side", "bottom"),
			expect(popup).toHaveAttr("aria-describedby", `${ID}-description`),
			expect(trigger).toHaveAttr("aria-expanded", "true"),
			expect(selector(`[aria-owns="${ID}-portal"]`)).toExist(),
		)
	})

	test("a flip reported by the positioner moves data-side", () => {
		scene(
			config,
			given(init(ID, { isOpen: true })),
			Mount.resolve(MountPopover, Message.ChangedPlacement({ side: "top", align: "center" })),
			expect(popup).toHaveAttr("data-side", "top"),
		)
	})

	test("a flipped popover reopens on its requested side, not the side it flipped to", () => {
		scene(
			config,
			given(init(ID, { isOpen: true })),
			Mount.resolve(MountPopover, Message.ChangedPlacement({ side: "top", align: "center" })),
			click(trigger),
			...exited(1),
			click(trigger),
			Mount.expectHas(
				MountPopover({
					id: ID,
					align: "center",
					side: "bottom",
					sideOffset: 4,
					isBare: false,
					initialFocus: "popup",
					fallbackAnchorSelector: null,
				}),
			),
			Mount.resolve(MountPopover, Message.CompletedMountPopover()),
			paint(2),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 2 }),
			),
			expect(popup).toHaveAttr("data-side", "bottom"),
		)
	})

	test("Escape closes it", () => {
		scene(
			config,
			given(init(ID, { isOpen: true })),
			Mount.resolve(MountPopover, Message.CompletedMountPopover()),
			keydown(portal, "Escape"),
			expect(trigger).toHaveAttr("aria-expanded", "false"),
			...exited(1),
		)
	})

	test("a press outside closes it", () => {
		scene(
			config,
			given(init(ID, { isOpen: true })),
			Mount.resolve(MountPopover, Message.PressedOutside()),
			expect(trigger).toHaveAttr("aria-expanded", "false"),
			...exited(1),
		)
	})

	test("the trigger and a Close button in the content close it", () => {
		scene(
			config,
			given(init(ID, { isOpen: true })),
			Mount.resolve(MountPopover, Message.CompletedMountPopover()),
			click(role("button", { name: "Done" })),
			expect(trigger).toHaveAttr("aria-expanded", "false"),
			...exited(1),
		)
		scene(
			config,
			given(init(ID, { isOpen: true })),
			Mount.resolve(MountPopover, Message.CompletedMountPopover()),
			click(trigger),
			expect(trigger).toHaveAttr("aria-expanded", "false"),
			...exited(1),
		)
	})
})
