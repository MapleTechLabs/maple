import { describe, expect, it } from "vitest"
import type { AlertContext, PageContextPayload, WidgetFixContext } from "./modes.ts"
import { buildSystemPrompt, modeFromInstanceId } from "./modes.ts"
import { orgIdFromInstanceId, tabIdFromInstanceId } from "./org.ts"

describe("instance id parsing", () => {
	it("splits org and tab on the first colon", () => {
		expect(orgIdFromInstanceId("org_123:alert-inc_9")).toBe("org_123")
		expect(tabIdFromInstanceId("org_123:alert-inc_9")).toBe("alert-inc_9")
	})
	it("treats a colon-less id as the org with no tab", () => {
		expect(orgIdFromInstanceId("org_123")).toBe("org_123")
		expect(tabIdFromInstanceId("org_123")).toBe("")
	})
	it("keeps colons inside the tab segment", () => {
		expect(tabIdFromInstanceId("org_1:a:b")).toBe("a:b")
	})
})

describe("modeFromInstanceId", () => {
	it.each([
		["org_1:alert-inc_9", "alert"],
		["org_1:widget-fix-dash_1-w2", "widget-fix"],
		["org_1:dashboard-builder-dash_1", "dashboard-builder"],
		["org_1:tab_random", "default"],
		["org_1", "default"],
	] as const)("%s -> %s", (id, expected) => {
		expect(modeFromInstanceId(id)).toBe(expected)
	})
})

describe("buildSystemPrompt", () => {
	const alertContext: AlertContext = {
		ruleId: "rule_1",
		ruleName: "High error rate",
		incidentId: "inc_9",
		eventType: "trigger",
		signalType: "error_rate",
		severity: "critical",
		comparator: "gt",
		threshold: 0.05,
		value: 0.12,
		windowMinutes: 15,
		groupKey: "checkout",
		sampleCount: 1000,
	}

	it("uses the default prompt for default mode", () => {
		const p = buildSystemPrompt({ mode: "default" })
		expect(p).toContain("observability debugging assistant")
		expect(p).not.toContain("dashboard building assistant")
	})

	it("uses the dashboard-builder prompt for dashboard-builder mode", () => {
		const p = buildSystemPrompt({ mode: "dashboard-builder" })
		expect(p).toContain("dashboard building assistant")
		expect(p).toContain("Test-Before-Propose")
	})

	it("appends the alert block only in alert mode with context", () => {
		const withCtx = buildSystemPrompt({ mode: "alert", alertContext })
		expect(withCtx).toContain("## Attached Alert")
		expect(withCtx).toContain('rule_name: "High error rate"')
		expect(withCtx).toContain("threshold: > 0.05")
		// the same context is ignored when not in alert mode
		expect(buildSystemPrompt({ mode: "default", alertContext })).not.toContain("## Attached Alert")
	})

	it("appends the widget-fix block only in widget-fix mode with context", () => {
		const widgetFixContext: WidgetFixContext = {
			dashboardId: "dash_1",
			widgetId: "w2",
			widgetTitle: "Errors",
			widgetJson: '{"id":"w2"}',
			errorTitle: "Invalid",
			errorMessage: "bad unit",
		}
		const p = buildSystemPrompt({ mode: "widget-fix", widgetFixContext })
		expect(p).toContain("## Broken Widget")
		expect(p).toContain("widget_id: w2")
	})

	it("appends page context in any mode when contexts are present", () => {
		const pageContext: PageContextPayload = {
			pathname: "/services/checkout",
			contexts: [{ kind: "service", id: "s1", serviceName: "checkout" }],
		}
		const p = buildSystemPrompt({ mode: "default", pageContext })
		expect(p).toContain("## Current Page Context")
		expect(p).toContain("- service: checkout")
		// an empty contexts list produces no block
		expect(
			buildSystemPrompt({ mode: "default", pageContext: { pathname: "/x", contexts: [] } }),
		).not.toContain("## Current Page Context")
	})
})
