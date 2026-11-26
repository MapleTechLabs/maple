import { String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { renderPagePush } from "./AlertMemberNotifier"

type PageContext = Parameters<typeof renderPagePush>[0]

const context = (overrides: Partial<PageContext> = {}): PageContext => ({
	ruleId: "00000000-0000-4000-8000-0000000000b1",
	ruleName: "Checkout error rate",
	groupKey: null,
	signalType: "error_rate",
	severity: "critical",
	comparator: "gt",
	threshold: 0.05,
	thresholdUpper: null,
	eventType: "trigger",
	incidentId: "00000000-0000-4000-8000-0000000000a1",
	incidentStatus: "open",
	dedupeKey: "rule:__total__",
	windowMinutes: 5,
	value: 0.091,
	sampleCount: 1260,
	...overrides,
})

describe("renderPagePush", () => {
	it("names the measured value against its threshold, and who the banner is for", () => {
		expect(renderPagePush(context())).toEqual({
			title: "You are paged · Checkout error rate",
			subtitle: undefined,
			body: "Critical. Error Rate 9.1% > 5%.",
		})
	})

	it("says which group breached for a rule that watches several", () => {
		const page = renderPagePush(context({ groupKey: "checkout-api", severity: "warning" }))
		expect(page.subtitle).toBe("checkout-api")
		expect(page.body).toBe("Warning. Error Rate 9.1% > 5%.")
	})

	it("lets a check's own sentence stand without a metric name in front", () => {
		const down = renderPagePush(
			context({
				signalType: "uptime",
				value: 1,
				detail: "GET https://shop.test/health timed out after 10s",
			}),
		)
		expect(down.body).toBe("Critical. GET https://shop.test/health timed out after 10s.")
		const anomaly = renderPagePush(context({ signalType: "anomaly", value: 2, detail: null }))
		expect(anomaly.body).toBe("Critical. Critical anomaly.")
	})

	it("says there was no data instead of naming a value that was never measured", () => {
		expect(renderPagePush(context({ value: null })).body).toBe("Critical. No data (threshold > 5%).")
	})

	it("cuts a long reason and a long rule name to what a banner shows", () => {
		const page = renderPagePush(
			context({
				signalType: "uptime",
				value: 1,
				detail: Str.repeat(400)("x"),
				ruleName: Str.repeat(100)("r"),
			}),
		)
		expect(page.body.length).toBeLessThanOrEqual("Critical. ".length + 160)
		expect(Str.endsWith("…")(page.body)).toBe(true)
		expect(page.title.length).toBeLessThanOrEqual("You are paged · ".length + 60)
	})
})
