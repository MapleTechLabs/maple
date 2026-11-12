import { BillingCustomer, BillingSubscription } from "@maple/domain/http"
import type { V2OnboardingChecklist } from "@maple/domain/http/v2"
import { Option, Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, role, scene, text } from "foldkit/scene"
import { describe, expect, test, vi } from "vitest"

// Clerk mode is read at import: without it the shell reads no checklist at all.
vi.hoisted(() => vi.stubEnv("VITE_MAPLE_AUTH_MODE", "clerk"))
import * as Popover from "@maple/views/ui/popover"
import { billingBanners } from "./billing-banners"
import { Message as ShellMessage, type Message } from "./message"
import { init } from "./model"
import { enter, routeChanged, update } from "./update"
import * as Checklist from "./onboarding-checklist"
import * as SupportChannel from "./support-channel"

const names = (result: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
	Arr.map(result.commands ?? [], (command) => command.name)

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
			grants: ["billing:manage"],
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

	const base = init({ isMobile: false, theme: "light", pinnedNamespaces: {}, dashboardFavorites: [] })
	const landed = (status: V2OnboardingChecklist["status"]) =>
		Checklist.Message.SucceededLoadChecklist({ checklist: checklist(status), nowMs: 0 })
	const shellStep = (model: typeof base, message: Checklist.Message) =>
		update(model, ShellMessage.GotChecklistMessage({ message })).model
	/** The countdown's clock, `seconds` after the read landed at 0. */
	const later = (model: Checklist.Model, seconds: number) =>
		Checklist.update(model, Checklist.Message.TickedClock({ nowMs: seconds * 1000 })).model

	test("the org's first read is not repeated by a navigation that follows it", () => {
		const first = Checklist.enter(Checklist.init())
		expect(names(first)).toContain("LoadOnboardingChecklist")
		// The shell reads the pill and its viewer on entering an org, and enters an org once.
		const entered = enter("org_1")(base)
		expect(names(entered)).toEqual(
			expect.arrayContaining(["LoadOnboardingChecklist", "LoadOnboardingChecklistViewer"]),
		)
		expect(names(enter("org_1")(entered.model))).toEqual([])

		// Not while the first read is still out, and not once it has landed, whatever it said.
		const reading = { ...base, checklist: first.model }
		expect(names(routeChanged(false)(reading))).toEqual([])
		for (const status of ["in_progress", "claimable", "claimed", "expired"] as const) {
			const shell = shellStep(reading, landed(status))
			expect(shell.checklist.checklist?.status).toBe(status)
			expect(names(routeChanged(false)(shell))).toEqual([])
			expect(names(routeChanged(true)(shell))).toEqual([])
		}
	})

	test("only one read is in flight: a second trigger waits for the first to land", () => {
		const open = Checklist.Message.GotPopoverMessage({ message: Popover.Message.ClickedTrigger() })
		const first = Checklist.update(loaded, open)
		expect(names(first)).toContain("LoadOnboardingChecklist")
		// A navigation onto a stale in-progress checklist starts no second read beside it.
		const inProgress = later({ ...first.model, checklist: checklist("in_progress") }, 120)
		expect(names(Checklist.navigated(inProgress))).toEqual([])
		// Closed and opened again before the answer: still the one read.
		const closed = { ...first.model, popover: loaded.popover }
		expect(names(Checklist.update(closed, open))).not.toContain("LoadOnboardingChecklist")
		// Once it lands the popover reads again, and so does a failed read.
		const after = Checklist.update(closed, landed("claimable")).model
		expect(names(Checklist.update(after, open))).toContain("LoadOnboardingChecklist")
		const failed = Checklist.update(closed, Checklist.Message.FailedLoadChecklist()).model
		expect(names(Checklist.update(failed, open))).toContain("LoadOnboardingChecklist")
	})

	test("a claim that lands during a read is read again after it, not beside it", () => {
		const reading = Checklist.update(
			{ ...loaded, isClaimPending: true },
			Checklist.Message.GotPopoverMessage({ message: Popover.Message.ClickedTrigger() }),
		).model
		const claimed = Checklist.update(reading, Checklist.Message.SucceededClaim())
		expect(names(claimed)).toEqual([])
		// The answer in flight predates the credit: the claim's own read follows it, once.
		const stale = Checklist.update(claimed.model, landed("claimable"))
		expect(names(stale)).toEqual(["LoadOnboardingChecklist"])
		expect(names(Checklist.update(stale.model, landed("claimed")))).toEqual([])
	})

	test("a navigation re-reads an in-progress checklist once it is stale, and a burst reads once", () => {
		const withStatus = (status: V2OnboardingChecklist["status"]) =>
			Checklist.update(Checklist.init(), landed(status)).model
		const inProgress = withStatus("in_progress")
		// Pages opened within seconds of the read reuse its answer.
		expect(names(Checklist.navigated(later(inProgress, 5)))).toEqual([])
		expect(names(Checklist.navigated(later(inProgress, 29)))).toEqual([])
		// A stale answer is read again, and the pages opened while that read is out add nothing.
		const reread = Checklist.navigated(later(inProgress, 30))
		expect(names(reread)).toEqual(["LoadOnboardingChecklist"])
		expect(names(Checklist.navigated(later(reread.model, 31)))).toEqual([])
		// Its answer is fresh again from the clock it landed at.
		const fresh = Checklist.update(
			reread.model,
			Checklist.Message.SucceededLoadChecklist({ checklist: checklist("in_progress"), nowMs: 31_000 }),
		).model
		expect(names(Checklist.navigated(later(fresh, 40)))).toEqual([])
		expect(names(Checklist.navigated(later(fresh, 61)))).toEqual(["LoadOnboardingChecklist"])
		// A settled checklist changes only through the claim, and no pill has nothing to refresh.
		for (const settled of ["claimable", "claimed", "expired"] as const)
			expect(names(Checklist.navigated(later(withStatus(settled), 600)))).toEqual([])
		expect(names(Checklist.navigated(later(Checklist.init(), 600)))).toEqual([])
		// The shell asks on a new page only, not on a search change within one.
		const stale = { ...base, checklist: later(inProgress, 30) }
		expect(names(routeChanged(false)(stale))).toEqual(["LoadOnboardingChecklist"])
		expect(names(routeChanged(true)(stale))).toEqual([])
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
