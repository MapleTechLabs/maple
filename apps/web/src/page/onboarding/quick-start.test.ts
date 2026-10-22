import { CatalogPlan, CatalogPlansResponse } from "@maple/domain/http"
import { Effect } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import * as PricingCards from "./pricing-cards"
import { init, Message, type Model, update } from "./quick-start"
import { DEFAULT_QUICK_START_STATE, resolveQuickStartStep } from "./quick-start-state"
import { LoadTeam, loadingTeam, TeamMessage, updateTeam } from "./quick-start-team"

const loaded = (): Model => ({ ...init("maple-onboarding-v6-org_1").model, state: DEFAULT_QUICK_START_STATE })

const names = (result: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
	(result.commands ?? []).map((command) => command.name)

const stateOf = (model: Model) => {
	if (model.state === null) throw new Error("not loaded")
	return model.state
}

describe("quick start", () => {
	test("the role step continues only with a role, then lands on intents; every change is saved", () => {
		const blocked = update(loaded(), Message.ClickedContinue({ step: "role" }))
		expect(names(blocked)).toEqual([])
		const picked = update(loaded(), Message.PickedRole({ role: "backend" }))
		expect(names(picked)).toEqual(["SaveQuickStartState"])
		const next = update(picked.model, Message.ClickedContinue({ step: "role" })).model
		expect(resolveQuickStartStep(stateOf(next))).toBe("intent")
		expect(stateOf(next).completedSteps).toEqual({ role: true })
	})

	test("Something else needs its free-text role before continuing", () => {
		const other = update(loaded(), Message.PickedRole({ role: "other" })).model
		expect(names(update(other, Message.ClickedContinue({ step: "role" })))).toEqual([])
		const described = update(other, Message.ChangedRoleDetail({ value: "Security engineer" })).model
		expect(resolveQuickStartStep(stateOf(update(described, Message.ClickedContinue({ step: "role" })).model))).toBe(
			"intent",
		)
	})

	test("intents toggle on and off, and Back returns to the role", () => {
		const atIntent = { ...loaded(), state: { ...DEFAULT_QUICK_START_STATE, activeStep: "intent" } }
		const twice = update(update(atIntent, Message.ToggledIntent({ intent: "logs" })).model, Message.ToggledIntent({ intent: "logs" }))
		expect(stateOf(twice.model).qualifyAnswers.intents).toEqual([])
		const back = update(atIntent, Message.ClickedBack({ to: "role" })).model
		expect(resolveQuickStartStep(stateOf(back))).toBe("role")
	})
})

describe("quick start team step", () => {
	const admin = updateTeam(loadingTeam(), TeamMessage.LoadedTeam({ name: "Orbit", canManage: true, invitations: [] })).team

	test("an admin invites a teammate once; an address already invited is refused", () => {
		const typed = updateTeam(admin, TeamMessage.ChangedTeammateEmail({ value: " grace@orbit.test " })).team
		const sent = updateTeam(typed, TeamMessage.SubmittedInvite())
		expect(sent.commands.map((command) => [command.name, command.args])).toEqual([
			["RunOnboardingTeamOperation", { operation: "invite", value: "grace@orbit.test" }],
		])
		expect(updateTeam(sent.team, TeamMessage.SubmittedRename()).commands).toEqual([])
		const done = updateTeam(sent.team, TeamMessage.SucceededTeamOperation({ operation: "invite", value: "grace@orbit.test" })).team
		expect(done).toMatchObject({ invited: ["grace@orbit.test"], email: "", pending: null })
		const again = updateTeam(updateTeam(done, TeamMessage.ChangedTeammateEmail({ value: "GRACE@orbit.test" })).team, TeamMessage.SubmittedInvite())
		expect(again.commands).toEqual([])
	})

	test("a member sees why the forms are off and cannot submit them", () => {
		const member = updateTeam(loadingTeam(), TeamMessage.LoadedTeam({ name: "Orbit", canManage: false, invitations: [] })).team
		expect(member.unavailableReason).not.toBeNull()
		const renamed = updateTeam(member, TeamMessage.ChangedWorkspaceName({ value: "Orbit Labs" })).team
		expect(updateTeam(renamed, TeamMessage.SubmittedRename()).commands).toEqual([])
	})
})

const plans = new CatalogPlansResponse({
	plans: [new CatalogPlan({ id: "startup", name: "Startup", items: [], customerEligibility: { trialAvailable: true } })],
})

describe("pricing cards", () => {
	const ready = PricingCards.update(PricingCards.init(), PricingCards.Message.SucceededLoadPlans({ response: plans })).model

	test("a plan's button attaches it once, then leaves for Stripe and re-reads the catalog", () => {
		const clicked = PricingCards.update(ready, PricingCards.Message.ClickedPlan({ planId: "startup" }))
		expect(names(clicked)).toEqual(["AttachPlan"])
		expect(
			names(
				PricingCards.update(clicked.model, PricingCards.Message.ClickedPlan({ planId: "startup" })),
			),
		).toEqual([])
		const attached = PricingCards.update(
			clicked.model,
			PricingCards.Message.SucceededAttach({ paymentUrl: "https://stripe.test/pay" }),
		)
		// oxlint-disable-next-line test-slop/no-exact-name-list -- tracking must run before the checkout navigates away
		expect(names(attached)).toEqual(["LoadPlans", "TrackCheckoutStarted", "OpenCheckout"])
		expect(attached.model.loadingPlanId).toBe("startup")
		expect(attached.outMessage).toEqual(PricingCards.OutMessage.ChangedPlan({ isLeavingForCheckout: true }))
	})

	test("back from Stripe, the cards wait on the sync: polling the customer, then giving up", () => {
		const returning = PricingCards.initReturning(true)
		expect(returning.model.checkoutReturn).toBe("Confirming")
		expect(returning.commands.map((command) => command.name)).toEqual(
			expect.arrayContaining(["WaitCheckoutPoll", "WaitCheckoutTimeout"]),
		)
		const polled = PricingCards.update(returning.model, PricingCards.Message.ElapsedCheckoutPoll())
		expect(polled.outMessage).toEqual(PricingCards.OutMessage.RequestedCustomerRefresh())
		expect(names(polled)).toEqual(["WaitCheckoutPoll"])
		const timedOut = PricingCards.update(returning.model, PricingCards.Message.ElapsedCheckoutTimeout())
		expect(timedOut.model.checkoutReturn).toBe("TimedOut")
		expect(timedOut.outMessage).toEqual(PricingCards.OutMessage.RequestedClearCheckoutMarker())
		expect(PricingCards.update(timedOut.model, PricingCards.Message.ElapsedCheckoutPoll()).outMessage).toBeUndefined()
	})

	test("a refused attach frees the button and reports the failure", () => {
		const clicked = PricingCards.update(ready, PricingCards.Message.ClickedPlan({ planId: "startup" })).model
		const failed = PricingCards.update(clicked, PricingCards.Message.FailedAttach({ message: "Card declined" }))
		expect(failed.model.loadingPlanId).toBeNull()
		expect(failed.outMessage).toEqual(PricingCards.OutMessage.FailedChangePlan({ message: "Card declined" }))
	})
})

describe("quick start team load", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	test("an admin whose pending invitations fail to load still gets the team step, with no invitations", async () => {
		const organization = { id: "org_1", name: "Acme", getInvitations: () => Promise.reject(new Error("Network down")) }
		vi.stubGlobal("window", {
			Clerk: { organization, user: { organizationMemberships: [{ organization: { id: "org_1" }, role: "org:admin" }] } },
		})
		const loaded = await Effect.runPromise(LoadTeam().effect)
		expect(loaded).toEqual(TeamMessage.LoadedTeam({ name: "Acme", canManage: true, invitations: [] }))
	})
})
