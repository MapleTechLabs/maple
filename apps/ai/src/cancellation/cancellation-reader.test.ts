import { describe, expect, it } from "vitest"
import { normalizeAnswer } from "./cancellation-reader"

const read = (verdict: "agree" | "override" | "context", reason: string | null, note: string | null) => {
	const { verdict: v, reason: r, note: n } = normalizeAnswer({ verdict, reason, note }, "m")
	return { verdict: v, reason: r, note: n }
}

describe("normalizeAnswer", () => {
	it("keeps an override that names its reason", () => {
		expect(read("override", " Needed SSO ", "Said so on Stripe.")).toEqual({
			verdict: "override",
			reason: "Needed SSO",
			note: "Said so on Stripe.",
		})
	})

	it("reads an override with no reason as context, or as agreement when it said nothing", () => {
		expect(read("override", "  ", "Hit the paywall.")).toEqual({
			verdict: "context",
			reason: null,
			note: "Hit the paywall.",
		})
		expect(read("override", null, null)).toEqual({ verdict: "agree", reason: null, note: null })
	})

	it("drops what an agreement or an empty note would add", () => {
		expect(read("agree", "Cost", "Same as the rules.")).toEqual({
			verdict: "agree",
			reason: null,
			note: null,
		})
		expect(read("context", null, " ")).toEqual({ verdict: "agree", reason: null, note: null })
	})
})
