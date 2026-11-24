import { describe, expect, it } from "vitest"
import { AlertDeliveryError, AlertDeliveryRejectedError } from "@maple/domain/http"
import { CostProviderError } from "../cost/CostProvider"
import { DELIVERY_USAGE_LIMIT_CODE, isAnticipatedAlertingFailure } from "./expected-failures"

const costFailure = (reason: CostProviderError["reason"]) =>
	new CostProviderError({ message: "m", provider: "openai", reason, requests: 0 })

describe("isAnticipatedAlertingFailure", () => {
	it("keeps a destination's own plan limit off error tracking, but not other refusals", () => {
		const limit = new AlertDeliveryRejectedError({
			message: "m",
			destinationType: "linear",
			providerErrorCode: DELIVERY_USAGE_LIMIT_CODE,
		})
		const rejected = new AlertDeliveryRejectedError({ message: "m", destinationType: "webhook" })
		expect(isAnticipatedAlertingFailure(limit)).toBe(true)
		expect(isAnticipatedAlertingFailure(rejected)).toBe(false)
		expect(isAnticipatedAlertingFailure(new AlertDeliveryError({ message: "m" }))).toBe(false)
	})

	it("treats a cost provider's rate limit as expected and its other failures as errors", () => {
		expect(isAnticipatedAlertingFailure(costFailure("rate_limited"))).toBe(true)
		expect(isAnticipatedAlertingFailure(costFailure("upstream"))).toBe(false)
		expect(isAnticipatedAlertingFailure(costFailure("auth"))).toBe(false)
	})

	it("ignores values that are not tagged failures", () => {
		expect(isAnticipatedAlertingFailure(undefined)).toBe(false)
		expect(isAnticipatedAlertingFailure("rate_limited")).toBe(false)
	})
})
