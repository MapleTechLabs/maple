import { describe, expect, it } from "vitest"
import {
	auditActionLabel,
	auditActions,
	auditMetadataValueLabel,
	AuditResources,
	auditResourceLabel,
	auditToolCallerLabel,
	isAuditAccessAction,
} from "./audit-actions"
import { internalAgentLabel } from "./system-agents"
import { Record as Rec, String as Str } from "effect"

describe("audit action labels", () => {
	it("labels every action in the catalog with a readable sentence, not the raw action", () => {
		const actions = auditActions()
		expect(actions.length).toBeGreaterThan(0)
		for (const action of actions) {
			const label = auditActionLabel(action)
			expect(label, action).not.toBeNull()
			expect(label, action).not.toContain("_")
			expect(label, action).not.toContain(".")
			const first = label?.[0]
			expect(first, action).toBe(first === undefined ? undefined : Str.toUpperCase(first))
		}
	})

	it("labels every resource type in the catalog", () => {
		for (const type of Rec.keys(AuditResources)) {
			expect(auditResourceLabel(type), type).not.toBeNull()
		}
	})

	it("returns null for an action or resource this build does not declare", () => {
		expect(auditActionLabel("dashboard.exploded")).toBeNull()
		expect(auditActionLabel("toString")).toBeNull()
		expect(auditResourceLabel("spaceship")).toBeNull()
	})
})

describe("access actions", () => {
	it("counts reading a key as access and replacing it as a change", () => {
		expect(isAuditAccessAction("aws_connection.events_key_read")).toBe(true)
		expect(isAuditAccessAction("aws_connection.stream_key_read")).toBe(true)
		expect(isAuditAccessAction("gcp_connector.push_secret_read")).toBe(true)
		expect(isAuditAccessAction("planetscale_integration.webhook_secret_read")).toBe(true)
		expect(isAuditAccessAction("aws_connection.events_key_rotated")).toBe(false)
		expect(isAuditAccessAction("aws_connection.updated")).toBe(false)
	})
})

describe("names for Maple's own agents and codes", () => {
	it("says which Maple agent called a tool, and keeps MCP for a customer's own client", () => {
		expect(auditToolCallerLabel("chat", "pr-review")).toBe("Maple code review")
		expect(auditToolCallerLabel("chat", "investigate")).toBe("Maple investigation")
		expect(auditToolCallerLabel("chat", null)).toBe("Maple agent")
		expect(auditToolCallerLabel("chat", "toString")).toBe("Maple agent")
		expect(auditToolCallerLabel("bot", null)).toBe("Maple bot")
		expect(auditToolCallerLabel("bot_anonymous", null)).toBe("Maple bot")
		expect(auditToolCallerLabel("mcp", null)).toBe("MCP tool")
	})

	it("puts internal metadata codes in words and leaves everything else as recorded", () => {
		expect(auditMetadataValueLabel("surface", "chat")).toBe("Maple agent")
		expect(auditMetadataValueLabel("surface", "bot_anonymous")).toBe("Maple bot")
		expect(auditMetadataValueLabel("agent", "pr-review")).toBe("Maple code review")
		expect(auditMetadataValueLabel("context", "mcp.run_sql")).toBe("run_sql tool")
		expect(auditMetadataValueLabel("context", "somethingNew")).toBeNull()
		expect(auditMetadataValueLabel("tool", "chat")).toBeNull()
	})

	it("names a chat connector's agent after its platform", () => {
		expect(internalAgentLabel("chat-connector-slack")).toBe("Maple bot in Slack")
		expect(internalAgentLabel("maple-triage-agent")).toBe("Maple Triage")
		expect(internalAgentLabel("chat-connector-")).toBeNull()
		expect(internalAgentLabel("my-agent")).toBeNull()
	})
})
