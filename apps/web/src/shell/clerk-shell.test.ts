import { BillingCustomer, BillingSubscription } from "@maple/domain/http"
import type { V2OnboardingChecklist } from "@maple/domain/http/v2"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, role, scene, text } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { isRedirectOnlyRoute } from "../page/chrome"
import { AppRoute } from "../route"
import * as Popover from "../ui/popover"
import { billingBanners } from "./billing-banners"
import { Message as ShellMessage, type Message } from "./message"
import { init } from "./model"
import { checklistRefreshOnNavigation, update } from "./update"
import * as Checklist from "./onboarding-checklist"
import * as SupportChannel from "./support-channel"

const names = (result: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
	(result.commands ?? []).map((command) => command.name)

const checklist = (status: V2OnboardingChecklist["status"]): V2OnboardingChecklist => ({
	object: "onboarding_checklist",
	status,
	reward_amount_usd: 30,
	deadline_at: "2026-10-02T08:00:00.000Z",
	claimed_at: null,
	completed_count: 4,
	total_count: 4,
	steps: [],
})

describe("onboarding reward pill", () => {
	const loaded = Checklist.update(
		Checklist.update(
			Checklist.init(),
			Checklist.Message.SucceededLoadChecklist({ checklist: checklist("claimable"), nowMs: 0 }),
		).model,
		Checklist.Message.LoadedViewer({
			isAdmin: true,
			seenKey: "maple-onboarding-reward-seen-v3-org:user",
			isSeen: false,
		}),
	).model

	test("opening the checklist re-reads it and retires the pointer for good", () => {
		const opened = Checklist.update(
			loaded,
			Checklist.Message.GotPopoverMessage({ message: Popover.Message.ClickedTrigger() }),
		)
		expect(opened.model.isSeen).toBe(true)
		expect(names(opened)).toEqual(
			expect.arrayContaining(["LoadOnboardingChecklist", "SaveOnboardingRewardSeen"]),
		)
	})

	test("an admin's claim runs once, then the popover keeps its claimed beat until it closes", () => {
		const claiming = Checklist.update(loaded, Checklist.Message.ClickedClaim())
		expect(names(claiming)).toEqual(["ClaimOnboardingReward"])
		expect(names(Checklist.update(claiming.model, Checklist.Message.ClickedClaim()))).toEqual([])
		const claimed = Checklist.update(claiming.model, Checklist.Message.SucceededClaim())
		expect(claimed.model).toMatchObject({ isJustClaimed: true, isClaimPending: false })
		expect(names(claimed)).toEqual(["LoadOnboardingChecklist"])
		const open = { ...claimed.model, popover: { ...claimed.model.popover, isOpen: true } }
		expect(Checklist.update(open, Checklist.Message.ClickedDone()).model.isJustClaimed).toBe(false)
	})

	test("a navigation re-reads the checklist only onto a page with the top bar (not /chat)", () => {
		const base = init({ isMobile: false, theme: "light", pinnedNamespaces: {}, dashboardFavorites: [] })
		const shell = { ...base, checklist: loaded }
		expect(names({ commands: checklistRefreshOnNavigation(shell, true, true) })).toEqual([
			"LoadOnboardingChecklist",
		])
		expect(checklistRefreshOnNavigation(shell, false, true)).toEqual([])
		expect(checklistRefreshOnNavigation({ ...base, checklist: Checklist.init() }, true, true)).toEqual([])
	})

	test("leaving a retired settings tab's redirect is not a navigation the pill saw", () => {
		expect(isRedirectOnlyRoute(AppRoute.Settings({ search: { tab: "organization" } }))).toBe(true)
		expect(isRedirectOnlyRoute(AppRoute.Settings({ search: { tab: "notifications" } }))).toBe(true)
		expect(isRedirectOnlyRoute(AppRoute.Settings({ search: { tab: "general" } }))).toBe(false)
		expect(isRedirectOnlyRoute(AppRoute.Settings({ search: {} }))).toBe(false)
	})

	test("a refused claim shows why", () => {
		const failed = Checklist.update(
			loaded,
			Checklist.Message.FailedClaim({ message: "Window closed" }),
		).model
		expect(failed.claimError).toBe("Window closed")
	})
})

describe("shared Slack channel dialog", () => {
	test("opening reads the channel; an invite is sent once and refreshes it; closing resets", () => {
		const opened = SupportChannel.open(SupportChannel.init())
		expect(names(opened)).toContain("LoadSupportChannel")
		const inviting = SupportChannel.update(opened.model, SupportChannel.Message.ClickedInvite())
		expect(names(inviting)).toEqual(["InviteToSupportChannel"])
		expect(names(SupportChannel.update(inviting.model, SupportChannel.Message.ClickedInvite()))).toEqual(
			[],
		)
		const channel = {
			object: "support_channel" as const,
			status: "active" as const,
			channel_name: "maple-acme",
			slack_url: null,
			created_at: null,
			invited_email: "ada@acme.test",
		}
		const invited = SupportChannel.update(
			inviting.model,
			SupportChannel.Message.SucceededInvite({ channel }),
		)
		expect(invited.model.invited).toEqual(channel)
		expect(names(invited)).toEqual(["LoadSupportChannel"])
	})
})

const lapsed = new BillingCustomer({
	id: "org_1",
	subscriptions: [
		new BillingSubscription({ planId: "startup", status: "expired", plan: { name: "Startup" } }),
	],
})

const bannerView =
	(customer: BillingCustomer) =>
	(_: null, h: HtmlBuilder<Message>): Html =>
		h.div([], billingBanners(h, Option.some(customer), false))

describe("billing banners", () => {
	test("a lapsed plan asks to choose a plan again", () => {
		scene(
			{ update: (model: null) => ({ model }), view: bannerView(lapsed) },
			given(null),
			expectView(text("Subscription ended")).toExist(),
			expectView(role("link", { name: "Choose a plan" })).toHaveAttr("href", "/select-plan"),
		)
		const shell = init({ isMobile: false, theme: "light", pinnedNamespaces: {}, dashboardFavorites: [] })
		expect(names(update(shell, ShellMessage.ClickedUpdatePaymentMethod()))).toEqual([
			"OpenCustomerPortal",
		])
		const dismissed = update(shell, ShellMessage.ClickedDismissQuotaBanner())
		expect(dismissed.model.isQuotaApproachingDismissed).toBe(true)
		expect(names(dismissed)).toEqual(["DismissQuotaBanner"])
	})
})
