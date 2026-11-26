import { IOS_APP_STORE_URL } from "@maple/domain/mobile-app"
import * as Popover from "@maple/views/ui/popover"
import { Option } from "effect"
import * as Animation from "@foldkit/ui/animation"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Command, click, expect, given, Mount, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import { iosAppPrompt, SaveIosPromptDismissed } from "./ios-app-prompt"
import { Message } from "./message"
import { init, type Model, type ShellClerk } from "./model"
import { update } from "./update"

// The sidebar's iPhone app row: who sees it, what it opens, and that dismissing it sticks per user.

const flags = { isMobile: false, theme: "dark", pinnedNamespaces: {}, dashboardFavorites: [] } as const

const clerkFor = (userId: string): ShellClerk => ({
	maybeUserId: Option.some(userId),
	maybeUser: Option.none(),
	maybeOrganization: Option.none(),
	memberships: [],
	customer: undefined,
	customerReadAtMs: 0,
	maybeGrants: Option.none(),
})

const rowFor =
	(clerk: ShellClerk | null) =>
	(model: Model, h: HtmlBuilder<Message>): Html =>
		h.ul([], iosAppPrompt(h, model, clerk))

const row = role("button", { name: "Get the iPhone app" })
const rowLink = role("link", { name: "Get the iPhone app" })
const store = role("link", { name: "Download on the App Store" })
const code = role("img", { name: "QR code to Maple Companion on the App Store" })
const dismiss = role("button", { name: "Don't show again" })

/** Click the row and settle the popover's Mount and its open transition (they map their own answers). */
const opened = [
	click(row),
	Mount.resolve(Popover.MountPopover, Popover.Message.CompletedMountPopover()),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
]

describe("iPhone app prompt", () => {
	test("the row opens a code to scan and the store link, and dismissing saves under the user's id", () => {
		scene(
			{ update, view: rowFor(clerkFor("user_a")) },
			given(init(flags)),
			expect(row).toHaveAttr("aria-expanded", "false"),
			expect(code).toBeAbsent(),
			...opened,
			expect(code).toExist(),
			expect(store).toHaveAttr("href", IOS_APP_STORE_URL),
			click(dismiss),
			Command.expectExact(SaveIosPromptDismissed({ userId: "user_a" })),
			Command.resolve(SaveIosPromptDismissed, Message.CompletedSaveIosPromptDismissed()),
			// The row leaves, and its popover with it.
			Mount.expectEnded(Popover.MountPopover),
			expect(row).toBeAbsent(),
			expect(code).toBeAbsent(),
		)
	})

	test("one user's dismissal, read from storage, leaves the row for the next user of the browser", () => {
		const dismissedByA = init({ ...flags, iosPromptDismissedUsers: ["user_a"] })
		scene({ update, view: rowFor(clerkFor("user_a")) }, given(dismissedByA), expect(row).toBeAbsent())
		scene({ update, view: rowFor(clerkFor("user_b")) }, given(dismissedByA), expect(row).toExist())
	})

	test("on a phone the row links straight to the listing, and a self-hosted shell gets no row", () => {
		scene(
			{ update, view: rowFor(clerkFor("user_a")) },
			given(init({ ...flags, isMobile: true })),
			expect(rowLink).toHaveAttr("href", IOS_APP_STORE_URL),
			expect(row).toBeAbsent(),
		)
		scene(
			{ update, view: rowFor(null) },
			given(init(flags)),
			expect(row).toBeAbsent(),
			expect(rowLink).toBeAbsent(),
		)
	})
})
