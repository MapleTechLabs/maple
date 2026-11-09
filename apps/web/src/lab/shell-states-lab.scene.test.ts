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
import {
	closeSheetNavigation,
	openSheetNavigation,
	sheetParamOf,
	withSheetParam,
} from "../page/kit/sheet-param"
import { Array as Arr, Option } from "effect"
import { MeasureSidebarOverflow } from "../shell/mounts"
import { Message as ShellMessage } from "../shell/message"
import {
	init,
	Message,
	type Model,
	PushSheetUrl,
	ReplaceSheetUrl,
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
	test("a link with ?sheet= opens it, and Escape clears the param in place", () => {
		scene(
			{ update, view },
			given(at(`/lab/shell?tab=x&sheet=${SHEET_ID}`)),
			measured,
			mounted,
			expect(dialog).toExist(),
			expect(dialog).toContainText("Error rate above (%)"),
			expect(role("button", { name: "Create rule" })).toExist(),
			keydown(portal, "Escape"),
			Command.expectHas(ReplaceSheetUrl({ url: "/lab/shell?tab=x" })),
			Command.resolve(ReplaceSheetUrl, Message.CompletedNavigate()),
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
			Command.expectExact(PushSheetUrl({ url: `/lab/shell?sheet=${SHEET_ID}` })),
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
			ReplaceSheetUrl.name,
		)
	})

	test("Cancel in the footer closes it and clears the param", () => {
		const closed = update(
			at(`/lab/shell?sheet=${SHEET_ID}`),
			Message.GotSheetMessage({ message: Dialog.Message.ClickedClose() }),
		)
		expectVitest(closed.model.sheet.isOpen).toBe(false)
		expectVitest(Arr.map(closed.commands ?? [], (command) => command.name)).toContain(
			ReplaceSheetUrl.name,
		)
	})
})

describe("sheet param", () => {
	test("sets and clears ?sheet= while keeping the other params and the hash", () => {
		expectVitest(withSheetParam("/alerts?tab=rules#top", "new-rule")).toBe(
			"/alerts?tab=rules&sheet=new-rule#top",
		)
		expectVitest(withSheetParam("/alerts?sheet=new-rule&tab=rules", undefined)).toBe("/alerts?tab=rules")
		expectVitest(sheetParamOf("/alerts?sheet=new-rule")).toEqual(Option.some("new-rule"))
		expectVitest(sheetParamOf("/alerts?sheet=")).toEqual(Option.none())
	})

	test("opening pushes a history entry; dismissing replaces it", () => {
		expectVitest(openSheetNavigation("/alerts", "new-rule")).toMatchObject({
			url: "/alerts?sheet=new-rule",
			isReplace: false,
		})
		expectVitest(closeSheetNavigation("/alerts?sheet=new-rule")).toMatchObject({
			url: "/alerts",
			isReplace: true,
		})
	})
})
