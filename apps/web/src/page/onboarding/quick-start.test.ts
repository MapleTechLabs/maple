import { CatalogPlan, CatalogPlansResponse } from "@maple/domain/http"
import { Effect } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import * as PricingCards from "./pricing-cards"
import { init, Message, type Model, update } from "./quick-start"
import { DEFAULT_QUICK_START_STATE, resolveQuickStartStep } from "./quick-start-state"
import { ConnectMessage } from "./quick-start-connect"
import { LoadTeam, loadingTeam, TeamMessage, updateTeam } from "./quick-start-team"

const loaded = (): Model => ({ ...init("maple-onboarding-v6-org_1").model, state: DEFAULT_QUICK_START_STATE })

const names = (result: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
	(result.commands ?? []).map((command) => command.name)

const stateOf = (model: Model) => {
	if (model.state === null) throw new Error("not loaded")
	return model.state
}

describe("quick start", () => {
	test("the plan comes first, and an org that already holds one starts on its stack", () => {
		expect(resolveQuickStartStep(DEFAULT_QUICK_START_STATE)).toBe("plan")
		expect(resolveQuickStartStep(DEFAULT_QUICK_START_STATE, true)).toBe("stack")
	})

	test("a save from the old role and intent steps resumes at the first step still to do", () => {
		const old = { ...DEFAULT_QUICK_START_STATE, activeStep: "intent", completedSteps: { role: true } }
		expect(resolveQuickStartStep(old, true)).toBe("stack")
	})

	test("stack picks are saved and set what the setup checklist shows", () => {
		const picked = update(loaded(), Message.ToggledLanguage({ language: "python" }))
		expect(names(picked)).toEqual(["SaveQuickStartState"])
		const withPlatform = update(picked.model, Message.ToggledPlatform({ platform: "supabase" })).model
		expect(stateOf(withPlatform).stack).toEqual({ languages: ["python"], platforms: ["supabase"] })
		expect(stateOf(withPlatform).selectedFramework).toBe("python")
		expect(stateOf(withPlatform).qualifyAnswers.intents).toContain("infrastructure")
		const unpicked = update(withPlatform, Message.ToggledLanguage({ language: "python" })).model
		expect(stateOf(unpicked).stack.languages).toEqual([])
	})

	test("the stack can be skipped, and the last step sends them on to where they were going", () => {
		const start = {
			...init("maple-onboarding-v6-org_1", false, false, "/traces").model,
			state: DEFAULT_QUICK_START_STATE,
		}
		const skipped = update(start, Message.ClickedContinue({ step: "stack" })).model
		expect(resolveQuickStartStep(stateOf(skipped), true)).toBe("connect")
		const connected = update(skipped, Message.ClickedContinue({ step: "connect" })).model
		expect(resolveQuickStartStep(stateOf(connected), true)).toBe("team")
		const teamed = update(connected, Message.ClickedContinue({ step: "team" })).model
		expect(resolveQuickStartStep(stateOf(teamed), true)).toBe("live")
		const done = update(teamed, Message.ClickedContinue({ step: "live" }))
		expect(done.commands?.map((command) => [command.name, command.args]).at(-1)).toEqual([
			"FinishQuickStart",
			{ url: "/traces" },
		])
	})

	test("someone who already finished is sent straight on when the page loads", () => {
		const finished = {
			...DEFAULT_QUICK_START_STATE,
			completedSteps: { plan: true, stack: true, connect: true, team: true, live: true },
		}
		const loading = init("maple-onboarding-v6-org_1").model
		expect(names(update(loading, Message.LoadedQuickStartState({ state: finished })))).toEqual([
			"FinishQuickStart",
		])
		expect(
			names(update(loading, Message.LoadedQuickStartState({ state: DEFAULT_QUICK_START_STATE }))),
		).not.toContain("FinishQuickStart")
	})
})

describe("quick start connect step", () => {
	const atStack = (): Model => ({
		...init("maple-onboarding-v6-org_1", false, false, "/", "org_1").model,
		state: {
			...DEFAULT_QUICK_START_STATE,
			activeStep: "stack",
			stack: { languages: ["nodejs"], platforms: ["cloudflare", "docker"] },
		},
	})

	test("opening it reads the ingest key, what is arriving, and the providers Maple can check", () => {
		const opened = update(atStack(), Message.ClickedContinue({ step: "stack" }))
		expect(names(opened)).toEqual(
			expect.arrayContaining([
				"FetchOnboardingConnectKeys",
				"LoadOnboardingConnectPresence",
				"LoadOnboardingConnectedProviders",
			]),
		)
		const providers = (opened.commands ?? []).find(
			(command) => command.name === "LoadOnboardingConnectedProviders",
		)
		expect(providers?.args).toEqual({ orgId: "org_1", providers: ["cloudflare"] })
		expect(opened.model.connect.isActive).toBe(true)
	})

	test("it keeps polling while it shows and stops once they move on", () => {
		const open = update(atStack(), Message.ClickedContinue({ step: "stack" })).model
		const polled = update(open, Message.GotConnectMessage({ message: ConnectMessage.ElapsedPoll() }))
		expect(names(polled)).toContain("LoadOnboardingConnectPresence")
		const left = update(open, Message.ClickedContinue({ step: "connect" })).model
		expect(left.connect.isActive).toBe(false)
		expect(
			names(update(left, Message.GotConnectMessage({ message: ConnectMessage.ElapsedPoll() }))),
		).toEqual([])
	})
})

describe("quick start team step", () => {
	const admin = updateTeam(
		loadingTeam(),
		TeamMessage.LoadedTeam({ name: "Orbit", canManage: true, invitations: [] }),
	).team

	test("an admin invites a teammate once; an address already invited is refused", () => {
		const typed = updateTeam(
			admin,
			TeamMessage.ChangedTeammateEmail({ value: " grace@orbit.test " }),
		).team
		const sent = updateTeam(typed, TeamMessage.SubmittedInvite())
		expect(sent.commands.map((command) => [command.name, command.args])).toEqual([
			["RunOnboardingTeamOperation", { operation: "invite", value: "grace@orbit.test" }],
		])
		expect(updateTeam(sent.team, TeamMessage.SubmittedRename()).commands).toEqual([])
		const done = updateTeam(
			sent.team,
			TeamMessage.SucceededTeamOperation({ operation: "invite", value: "grace@orbit.test" }),
		).team
		expect(done).toMatchObject({ invited: ["grace@orbit.test"], email: "", pending: null })
		const again = updateTeam(
			updateTeam(done, TeamMessage.ChangedTeammateEmail({ value: "GRACE@orbit.test" })).team,
			TeamMessage.SubmittedInvite(),
		)
		expect(again.commands).toEqual([])
	})

	test("a member sees why the forms are off and cannot submit them", () => {
		const member = updateTeam(
			loadingTeam(),
			TeamMessage.LoadedTeam({ name: "Orbit", canManage: false, invitations: [] }),
		).team
		expect(member.unavailableReason).not.toBeNull()
		const renamed = updateTeam(member, TeamMessage.ChangedWorkspaceName({ value: "Orbit Labs" })).team
		expect(updateTeam(renamed, TeamMessage.SubmittedRename()).commands).toEqual([])
	})
})

const plans = new CatalogPlansResponse({
	plans: [
		new CatalogPlan({
			id: "startup",
			name: "Startup",
			items: [],
			customerEligibility: { trialAvailable: true },
		}),
	],
})

describe("pricing cards", () => {
	const ready = PricingCards.update(
		PricingCards.init(),
		PricingCards.Message.SucceededLoadPlans({ response: plans }),
	).model

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
		expect(attached.outMessage).toEqual(
			PricingCards.OutMessage.ChangedPlan({ isLeavingForCheckout: true }),
		)
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
		expect(
			PricingCards.update(timedOut.model, PricingCards.Message.ElapsedCheckoutPoll()).outMessage,
		).toBeUndefined()
	})

	test("a refused attach frees the button and reports the failure", () => {
		const clicked = PricingCards.update(
			ready,
			PricingCards.Message.ClickedPlan({ planId: "startup" }),
		).model
		const failed = PricingCards.update(
			clicked,
			PricingCards.Message.FailedAttach({ message: "Card declined" }),
		)
		expect(failed.model.loadingPlanId).toBeNull()
		expect(failed.outMessage).toEqual(
			PricingCards.OutMessage.FailedChangePlan({ message: "Card declined" }),
		)
	})
})

describe("quick start team load", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	test("an admin whose pending invitations fail to load still gets the team step, with no invitations", async () => {
		const organization = {
			id: "org_1",
			name: "Acme",
			getInvitations: () => Promise.reject(new Error("Network down")),
		}
		vi.stubGlobal("window", {
			Clerk: {
				organization,
				user: { organizationMemberships: [{ organization: { id: "org_1" }, role: "org:admin" }] },
			},
		})
		const loaded = await Effect.runPromise(LoadTeam().effect)
		expect(loaded).toEqual(TeamMessage.LoadedTeam({ name: "Acme", canManage: true, invitations: [] }))
	})
})
