import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import type { BillingCustomer } from "@maple/domain/http"
import { UpdateBillingControlsRequest } from "@maple/domain/http"

import { maximumInvoiceCents, parseCapInput, uncappedFeatures, updateFeatureControls } from "./controls"
import type { SpendModel } from "./spend"

const customer = {
	id: "org_test",
	subscriptions: [],
	billingControls: {
		spendLimits: [
			{
				featureId: "traces",
				enabled: true,
				limitType: "absolute",
				overageLimit: 75,
			},
		],
	},
} as BillingCustomer

describe("updateFeatureControls", () => {
	// The endpoint payload is a Schema.Class, so the HttpApi client encoder checks
	// class identity: a plain literal dies with "Expected UpdateBillingControlsRequest"
	// before any request goes out, and tsc can't see it.
	it("returns a payload the endpoint encoder accepts", () => {
		const next = updateFeatureControls({ featureId: "logs", overageLimit: 250 })

		expect(() => Schema.encodeUnknownSync(UpdateBillingControlsRequest)(next)).not.toThrow()
	})

	it("sends only the selected feature; the API merges it over the other caps", () => {
		const next = updateFeatureControls({ featureId: "logs", overageLimit: 250 })

		expect(next.spendLimits).toEqual([
			{
				featureId: "logs",
				enabled: true,
				limitType: "absolute",
				overageLimit: 250,
			},
		])
		expect(next.spendLimits[0]).not.toHaveProperty("skipOverageBilling")
		// Omitted, not empty: the provider replaces the list, so [] would wipe existing alerts.
		expect(next).not.toHaveProperty("usageAlerts")
	})

	it("explicitly disables the cap when the field is cleared", () => {
		const next = updateFeatureControls({ featureId: "logs", overageLimit: null })

		expect(next.spendLimits).toEqual([{ featureId: "logs", enabled: false }])
		expect(next).not.toHaveProperty("usageAlerts")
	})
})

describe("maximumInvoiceCents", () => {
	// SAFETY: maximumInvoiceCents reads only the base and per-feature cap fields supplied by this focused fixture.
	const model = {
		baseCents: 3_900,
		partial: false,
		features: [
			{ featureId: "logs", ratePerUnit: 0.3, unlimited: false, overageAllowed: true },
			{ featureId: "traces", ratePerUnit: 0.3, unlimited: false, overageAllowed: true },
			{ featureId: "metrics", ratePerUnit: 0.3, unlimited: true, overageAllowed: true },
			{ featureId: "browser_sessions", ratePerUnit: 0.002, unlimited: false, overageAllowed: false },
		],
	} as unknown as SpendModel

	it("adds every billable feature cap to the base invoice", () => {
		expect(
			maximumInvoiceCents(model, {
				...customer,
				billingControls: {
					spendLimits: [
						{ featureId: "logs", enabled: true, limitType: "absolute", overageLimit: 100 },
						{ featureId: "traces", enabled: true, limitType: "absolute", overageLimit: 50 },
					],
				},
			} as BillingCustomer),
		).toBe(8_400)
	})

	it("is unbounded when any billable feature is uncapped", () => {
		expect(maximumInvoiceCents(model, customer)).toBeNull()
	})

	it("counts only billable features without a cap as uncapped", () => {
		// Metrics is unlimited and sessions are hard-capped: no cap can bound either.
		expect(uncappedFeatures(model, customer).map((feature) => feature.featureId)).toEqual(["logs"])
	})
})

describe("parseCapInput", () => {
	it("reads an empty field as removing the cap", () => {
		expect(parseCapInput("  ")).toEqual({ valid: true, cap: null })
	})

	it("accepts zero and decimals", () => {
		expect(parseCapInput("0")).toEqual({ valid: true, cap: 0 })
		expect(parseCapInput("12.5")).toEqual({ valid: true, cap: 12.5 })
	})

	it("rejects negative and non-numeric input", () => {
		expect(parseCapInput("-1")).toEqual({ valid: false })
		expect(parseCapInput("abc")).toEqual({ valid: false })
	})

	it("rejects half-typed and non-decimal numbers instead of reading them as no cap", () => {
		expect(parseCapInput("1e")).toEqual({ valid: false })
		expect(parseCapInput("1e3")).toEqual({ valid: false })
		expect(parseCapInput("0x10")).toEqual({ valid: false })
		expect(parseCapInput("Infinity")).toEqual({ valid: false })
		expect(parseCapInput(" 7. ")).toEqual({ valid: true, cap: 7 })
	})
})
