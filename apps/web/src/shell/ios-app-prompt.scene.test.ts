import { IOS_APP_STORE_URL } from "@maple/domain/mobile-app"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Command, click, expect, given, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import { iosAppPrompt, SaveIosPromptDismissed } from "./ios-app-prompt"
import { Message } from "./message"
import { init, type Model, type ShellClerk } from "./model"
import { update } from "./update"

// The sidebar's iPhone app card: who sees it, where it sends them, and that closing it sticks per user.

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

const cardFor =
	(clerk: ShellClerk | null) =>
	(model: Model, h: HtmlBuilder<Message>): Html =>
		h.div([], iosAppPrompt(h, model, clerk))

const store = role("link", { name: "Download on the App Store" })
const code = role("img", { name: "QR code to Maple Companion on the App Store" })
const dismiss = role("button", { name: "Dismiss" })

describe("iPhone app prompt", () => {
	test("a signed-in user gets the store link and a code to scan, and closing it saves under their id", () => {
		scene(
			{ update, view: cardFor(clerkFor("user_a")) },
			given(init(flags)),
			expect(store).toHaveAttr("href", IOS_APP_STORE_URL),
			expect(code).toExist(),
			click(dismiss),
			Command.expectExact(SaveIosPromptDismissed({ userId: "user_a" })),
			Command.resolve(SaveIosPromptDismissed, Message.CompletedSaveIosPromptDismissed()),
			expect(store).toBeAbsent(),
		)
	})

	test("one user's dismissal, read from storage, leaves the card for the next user of the browser", () => {
		const dismissedByA = init({ ...flags, iosPromptDismissedUsers: ["user_a"] })
		scene({ update, view: cardFor(clerkFor("user_a")) }, given(dismissedByA), expect(store).toBeAbsent())
		scene({ update, view: cardFor(clerkFor("user_b")) }, given(dismissedByA), expect(store).toExist())
	})

	test("a phone gets the badge without a code, and a self-hosted shell gets no card", () => {
		scene(
			{ update, view: cardFor(clerkFor("user_a")) },
			given(init({ ...flags, isMobile: true })),
			expect(store).toExist(),
			expect(code).toBeAbsent(),
		)
		scene({ update, view: cardFor(null) }, given(init(flags)), expect(store).toBeAbsent())
	})
})
