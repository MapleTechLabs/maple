import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import * as PricingCards from "./pricing-cards"
import { init, Message, update } from "./select-plan"

const names = (result: { readonly commands?: ReadonlyArray<{ readonly name: string }> }) =>
	Arr.map(result.commands ?? [], (command) => command.name)

describe("select plan", () => {
	test("back from Stripe, a live subscription ends the wait as confirmed and clears the marker", () => {
		const returning = init(true).model
		expect(returning.pricing.checkoutReturn).toBe("Confirming")
		const seen = update(returning, Message.SettledPlan({ isPlanActive: true }))
		expect(names(seen)).toContain("TrackCheckoutReturned")
		expect(seen.model.pricing.checkoutReturn).toBe("Idle")
		expect(seen.outMessage).toEqual(PricingCards.OutMessage.RequestedClearCheckoutMarker())
	})

	test("app access without a live subscription keeps waiting and records nothing", () => {
		const returning = init(true).model
		const failOpen = update(returning, Message.SettledPlan({ isPlanActive: false }))
		expect(names(failOpen)).not.toContain("TrackCheckoutReturned")
		expect(failOpen.model.pricing.checkoutReturn).toBe("Confirming")
	})

	test("a visit that did not come back from Stripe records no return", () => {
		expect(names(update(init(false).model, Message.SettledPlan({ isPlanActive: true })))).not.toContain(
			"TrackCheckoutReturned",
		)
	})
})
