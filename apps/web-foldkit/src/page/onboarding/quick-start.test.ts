import { CatalogPlan, CatalogPlansResponse } from "@maple/domain/http"
import { describe, expect, test } from "vitest"
import * as PricingCards from "./pricing-cards"
import { Message, type Model, update } from "./quick-start"
import { DEFAULT_QUICK_START_STATE, resolveQuickStartStep } from "./quick-start-state"

const loaded = (): Model => ({ _tag: "QuickStart", storageKey: "maple-onboarding-v6-org_1", state: DEFAULT_QUICK_START_STATE })

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

const plans = new CatalogPlansResponse({
	plans: [new CatalogPlan({ id: "startup", name: "Startup", items: [], customerEligibility: { trialAvailable: true } })],
})

describe("pricing cards", () => {
	const ready = PricingCards.update(PricingCards.init(), PricingCards.Message.SucceededLoadPlans({ response: plans })).model

	test("a plan's button attaches it once, then leaves for Stripe and re-reads the catalog", () => {
		const clicked = PricingCards.update(ready, PricingCards.Message.ClickedPlan({ planId: "startup" }))
		expect(names(clicked)).toEqual(["AttachPlan"])
		expect(names(PricingCards.update(clicked.model, PricingCards.Message.ClickedPlan({ planId: "startup" })))).toEqual([])
		const attached = PricingCards.update(clicked.model, PricingCards.Message.SucceededAttach({ paymentUrl: "https://stripe.test/pay" }))
		expect(names(attached)).toEqual(["LoadPlans", "OpenCheckout"])
		expect(attached.model.loadingPlanId).toBe("startup")
		expect(attached.outMessage).toEqual(PricingCards.OutMessage.ChangedPlan({ isLeavingForCheckout: true }))
	})

	test("a refused attach frees the button and reports the failure", () => {
		const clicked = PricingCards.update(ready, PricingCards.Message.ClickedPlan({ planId: "startup" })).model
		const failed = PricingCards.update(clicked, PricingCards.Message.FailedAttach({ message: "Card declined" }))
		expect(failed.model.loadingPlanId).toBeNull()
		expect(failed.outMessage).toEqual(PricingCards.OutMessage.FailedChangePlan({ message: "Card declined" }))
	})
})
