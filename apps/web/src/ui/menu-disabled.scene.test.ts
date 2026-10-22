import * as Animation from "@foldkit/ui/animation"
import { inertHtml as ih } from "foldkit/html"
import {
	Command,
	expect,
	expectNoOutMessage,
	expectOutMessage,
	given,
	keydown,
	Mount,
	role,
	scene,
	withViewInputs,
} from "foldkit/scene"
import { describe, test } from "vitest"
import { FocusMenuItem, init, Message, MountMenu, OutMessage, update, WaitForMenuExit } from "./menu"
import { type MenuEntry, view } from "./menu-view"

/** Base UI keeps a disabled item reachable by arrows (empty `disabledIndices`) but never runs it. */
const ID = "member-actions"

const ENTRIES: ReadonlyArray<MenuEntry> = [
	{ _tag: "Item", value: "resend", label: "Resend invite" },
	{ _tag: "Item", value: "revoke", label: "Revoke invite", isDisabled: true },
]

const config = {
	update,
	view: withViewInputs(view, {
		entries: ENTRIES,
		toView: ({ trigger, withTrigger }) => ih.main([], withTrigger(ih.button([...trigger], ["Member actions"]))),
	})(),
}
const menu = role("menu", { name: "Member actions" })
const item = (name: string) => role("menuitem", { name })
const focused = () => Command.resolve(FocusMenuItem, Message.CompletedFocusMenuItem())

describe("dropdown menu disabled items", () => {
	test("Enter on a highlighted disabled item does nothing; an enabled one is selected", () => {
		scene(
			config,
			given(init(ID, { isOpen: true })),
			Mount.resolve(MountMenu, Message.CompletedMountMenu()),
			keydown(menu, "End"),
			focused(),
			expect(item("Revoke invite")).toHaveAttr("data-highlighted", ""),
			keydown(menu, "Enter"),
			expectNoOutMessage(),
			keydown(menu, "Home"),
			focused(),
			keydown(menu, "Enter"),
			expectOutMessage(OutMessage.SelectedItem({ value: "resend" })),
			Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
			Command.resolve(
				WaitForMenuExit({ id: ID, generation: 1 }),
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			Mount.expectEnded(MountMenu),
		)
	})
})
