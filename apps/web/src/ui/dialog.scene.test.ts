import * as Animation from "@foldkit/ui/animation"
import { inertHtml as ih } from "foldkit/html"
import {
	click,
	Command,
	expect,
	expectOutMessage,
	given,
	keydown,
	Mount,
	role,
	scene,
	selector,
	withViewInputs,
} from "foldkit/scene"
import { describe, test } from "vitest"
import { init, Message, MountDialog, OutMessage, update, WaitForDialogTransition } from "./dialog"
import { dialogDescription, dialogFooter, dialogHeader, dialogTitle, view } from "./dialog-view"

/** Dialog through its view: trigger, Escape, outside press, Close buttons and the exit transition. */
const ID = "rename"

const sceneView = withViewInputs(view, {
	toView: ({ trigger, portal }) => ih.main([], [ih.button([...trigger], ["Rename dashboard"]), portal]),
	toContent: (close) => [
		dialogHeader(ih, "dialog", [
			dialogTitle(ih, "dialog", ID, "Rename dashboard"),
			dialogDescription(ih, "dialog", ID, "Shown in the sidebar."),
		]),
		dialogFooter(ih, "dialog", [ih.button([...close], ["Cancel"])]),
	],
})

const config = () => ({ update, view: sceneView() })

const dialog = role("dialog", { name: "Rename dashboard" })
const trigger = role("button", { name: "Rename dashboard" })
const portal = selector("[data-base-ui-portal]")

/** Opening: the portal Mount, then the enter transition's paint and settle. */
const opened = [
	Mount.resolve(MountDialog, Message.CompletedMountDialog()),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
]

/** Closing: the exit transition, after which the portal and its Mount are gone. */
const closed = (generation: number) => [
	expect(dialog).toHaveAttr("data-ending-style", ""),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation })),
	Command.resolve(
		WaitForDialogTransition({ id: ID, generation }),
		Message.GotAnimationMessage({ message: Animation.Message.EndedAnimation({ generation }) }),
	),
	Mount.expectEnded(MountDialog),
	expect(dialog).toBeAbsent(),
]

describe("dialog scene", () => {
	test("the trigger opens a dialog labelled by its title, with Base UI's state attributes", () => {
		scene(
			config(),
			given(init(ID, "dialog")),
			expect(dialog).toBeAbsent(),
			expect(trigger).toHaveAttr("aria-expanded", "false"),
			click(trigger),
			expectOutMessage(OutMessage.Opened()),
			expect(dialog).toHaveAttr("data-starting-style", ""),
			...opened,
			expect(dialog).toHaveAttr("data-open", ""),
			expect(dialog).not.toHaveAttr("data-starting-style"),
			expect(trigger).toHaveAttr("aria-expanded", "true"),
			expect(trigger).toHaveAttr("aria-controls", `${ID}-popup`),
		)
	})

	test("Escape closes it and the portal leaves after the exit transition", () => {
		scene(
			config(),
			given(init(ID, "dialog", { isOpen: true })),
			Mount.resolve(MountDialog, Message.CompletedMountDialog()),
			keydown(portal, "Escape"),
			expectOutMessage(OutMessage.Closed()),
			...closed(1),
		)
	})

	// The Mount watches presses on the document; Scene feeds its outside press as the Mount's result.
	test("a press outside the popup dismisses it", () => {
		scene(
			config(),
			given(init(ID, "dialog", { isOpen: true })),
			Mount.resolve(MountDialog, Message.PressedOutside()),
			expect(trigger).toHaveAttr("aria-expanded", "false"),
			...closed(1),
		)
	})

	test("a Close button in the content and the close icon both close it", () => {
		scene(
			config(),
			given(init(ID, "dialog", { isOpen: true })),
			Mount.resolve(MountDialog, Message.CompletedMountDialog()),
			click(role("button", { name: "Cancel" })),
			expect(trigger).toHaveAttr("aria-expanded", "false"),
			...closed(1),
		)
		scene(
			config(),
			given(init(ID, "dialog", { isOpen: true })),
			Mount.resolve(MountDialog, Message.CompletedMountDialog()),
			click(role("button", { name: "Close" })),
			expect(trigger).toHaveAttr("aria-expanded", "false"),
			...closed(1),
		)
	})

	test("an alert dialog ignores outside presses and has no close icon", () => {
		scene(
			config(),
			given(init(ID, "alert-dialog", { isOpen: true })),
			Mount.resolve(MountDialog, Message.PressedOutside()),
			expect(role("alertdialog", { name: "Rename dashboard" })).toExist(),
			expect(role("button", { name: "Close" })).toBeAbsent(),
			expect(role("alertdialog", { name: "Rename dashboard" })).toHaveAttr("data-open", ""),
		)
	})
})
