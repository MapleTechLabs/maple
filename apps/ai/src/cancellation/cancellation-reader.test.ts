import { describe, expect, it } from "vitest"
import { normalizeAnswer } from "./cancellation-reader"

const read = (verdict: "agree" | "override" | "context", reason: string | null, note: string | null) => {
	const { verdict: v, reason: r, note: n } = normalizeAnswer({ verdict, category: null, reason, note }, "m")
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

	it("files an override under its category, and under other when it gave none", () => {
		const answer = { verdict: "override" as const, reason: "Needed SSO", note: null }
		expect(normalizeAnswer({ ...answer, category: "missing_features" }, "m").category).toBe(
			"missing_features",
		)
		expect(normalizeAnswer({ ...answer, category: null }, "m").category).toBe("other")
		expect(
			normalizeAnswer({ ...answer, verdict: "context", category: "cost", note: "x" }, "m").category,
		).toBeNull()
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
