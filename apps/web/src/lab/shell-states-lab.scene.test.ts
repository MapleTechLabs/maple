import * as Animation from "@foldkit/ui/animation"
import {
	Command,
	click,
	expect,
	given,
	keydown,
	Mount,
	role,
	scene,
	selector,
	Subscription,
} from "foldkit/scene"
import { describe, expect as expectVitest, test } from "vitest"
import * as Dialog from "@maple/views/ui/dialog"
import { Array as Arr } from "effect"
import { MeasureSidebarOverflow } from "../shell/mounts"
import { Message as ShellMessage } from "../shell/message"
import {
	init,
	Message,
	type Model,
	DismissSheetUrl,
	PushSheetUrl,
	SHEET_ID,
	update,
	view,
} from "./shell-states-lab"

// The right sheet held in `?sheet=`: the URL opens it, Escape and the backdrop clear it, Back closes it.

const shellFlags = { isMobile: false, theme: "dark", pinnedNamespaces: {}, dashboardFavorites: [] } as const

const at = (href: string): Model => init({ shell: shellFlags, href }).model

const dialog = role("dialog", { name: "New alert rule" })
const portal = selector("[data-base-ui-portal]")

const measured = Mount.resolve(MeasureSidebarOverflow, ShellMessage.MeasuredSidebarOverflow())

/** The portal Mount and the enter transition (or none, for a sheet that boots open). */
const mounted = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

const enter = (generation: number) => [
	mounted,
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation })),
]

const leave = (generation: number) => [
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation })),
	Command.resolve(
		Dialog.WaitForDialogTransition({ id: SHEET_ID, generation }),
		Dialog.Message.GotAnimationMessage({ message: Animation.Message.EndedAnimation({ generation }) }),
	),
	Mount.expectEnded(Dialog.MountDialog),
	expect(dialog).toBeAbsent(),
]

describe("URL-held right sheet", () => {
	test("a link with ?sheet= opens it, and Escape dismisses it through the URL", () => {
		scene(
			{ update, view },
			given(at(`/lab/shell?tab=x&sheet=${SHEET_ID}`)),
			measured,
			mounted,
			expect(dialog).toExist(),
			expect(dialog).toContainText("Error rate above (%)"),
			expect(role("button", { name: "Create rule" })).toExist(),
			keydown(portal, "Escape"),
			Command.expectHas(DismissSheetUrl({ href: `/lab/shell?tab=x&sheet=${SHEET_ID}`, id: SHEET_ID })),
			Command.resolve(DismissSheetUrl, Message.CompletedNavigate()),
			// Booting open counted the show as generation 1.
			...leave(2),
		)
	})

	test("the page's button pushes ?sheet=, the URL change opens it, and Back closes it", () => {
		scene(
			{ update, view },
			given(at("/lab/shell")),
			measured,
			expect(dialog).toBeAbsent(),
			click(role("button", { name: "New alert rule" })),
			Command.expectExact(PushSheetUrl({ href: "/lab/shell", id: SHEET_ID })),
			Command.resolve(PushSheetUrl, Message.CompletedNavigate()),
			expect(dialog).toBeAbsent(),
			Subscription.emit(Message.ChangedUrl({ href: `/lab/shell?sheet=${SHEET_ID}` })),
			...enter(1),
			expect(dialog).toHaveAttr("data-open", ""),
			Subscription.emit(Message.ChangedUrl({ href: "/lab/shell" })),
			...leave(2),
			Command.expectNone(),
		)
	})

	test("Back (the URL losing ?sheet=) closes it without touching the URL again", () => {
		const open = at(`/lab/shell?sheet=${SHEET_ID}`)
		const back = update(open, Message.ChangedUrl({ href: "/lab/shell" }))
		expectVitest(back.model.sheet.isOpen).toBe(false)
		expectVitest(Arr.map(back.commands ?? [], (command) => command.name)).not.toContain(
			DismissSheetUrl.name,
		)
	})

	test("Cancel in the footer dismisses it like Escape", () => {
		scene(
			{ update, view },
			given(at(`/lab/shell?sheet=${SHEET_ID}`)),
			measured,
			mounted,
			expect(dialog).toExist(),
			click(role("button", { name: "Cancel" })),
			Command.expectHas(DismissSheetUrl({ href: `/lab/shell?sheet=${SHEET_ID}`, id: SHEET_ID })),
			Command.resolve(DismissSheetUrl, Message.CompletedNavigate()),
			...leave(2),
		)
	})
})
