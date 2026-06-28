import { describe, expect, it } from "vitest"
import { buildContextPreamble, stripContextPreamble, wrapContextPreamble } from "./context-preamble"
import type { AlertContext } from "./alert-context"
import { alertContextToInvestigation } from "./investigation-context"
import type { WidgetFixContext } from "./widget-fix-context"

const alert: AlertContext = {
	ruleId: "rule_1",
	ruleName: "High error rate",
	incidentId: "inc_1",
	eventType: "trigger",
	signalType: "error_rate",
	severity: "critical",
	comparator: "gt",
	threshold: 0.05,
	value: 0.12,
	windowMinutes: 15,
	groupKey: "checkout-api",
	sampleCount: 42,
}

const widgetFix: WidgetFixContext = {
	dashboardId: "dash_1",
	widgetId: "widget_1",
	widgetTitle: "Latency",
	widgetJson: '{"id":"widget_1"}',
	errorTitle: "Invalid visualization",
	errorMessage: "unknown field",
}

describe("context preamble", () => {
	it("wraps and strips round-trip, leaving only the user text", () => {
		const wrapped = wrapContextPreamble("## Attached Alert\nrule_id: rule_1", "what happened?")
		expect(wrapped).toContain("## Attached Alert")
		expect(stripContextPreamble(wrapped)).toBe("what happened?")
	})

	it("leaves plain text untouched", () => {
		expect(stripContextPreamble("just a question")).toBe("just a question")
	})

	it("only strips a leading block (not one mid-message)", () => {
		const text = "hello <!--maple:context-->x<!--/maple:context-->"
		expect(stripContextPreamble(text)).toBe(text)
	})

	it("builds an investigation block (alert subject)", () => {
		const block = buildContextPreamble({
			mode: "investigation",
			investigationContext: alertContextToInvestigation(alert),
		})
		expect(block).toContain("## Attached Alert")
		expect(block).toContain("kind: alert")
		expect(block).toContain('group: "checkout-api"')
	})

	it("builds a widget-fix block", () => {
		const block = buildContextPreamble({ mode: "widget-fix", widgetFixContext: widgetFix })
		expect(block).toContain("## Broken Widget — Propose a Fix")
		expect(block).toContain("widget_id: widget_1")
	})

	it("builds a page-context block", () => {
		const block = buildContextPreamble({
			pageContext: {
				pathname: "/services/checkout-api",
				contexts: [{ kind: "service", id: "service:checkout-api", serviceName: "checkout-api" }],
			},
		})
		expect(block).toContain("## Current Page Context")
		expect(block).toContain("- service: checkout-api")
	})

	it("returns empty when there's no context", () => {
		expect(buildContextPreamble({})).toBe("")
		expect(
			buildContextPreamble({ mode: "widget-fix", pageContext: { pathname: "/x", contexts: [] } }),
		).toBe("")
	})
})
