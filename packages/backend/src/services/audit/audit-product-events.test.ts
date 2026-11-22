import { describe, expect, it } from "vitest"
import { OrgId, UserId } from "@maple/primitives"
import { Array as Arr, Schema } from "effect"
import { AuditLogEvent } from "./audit-event"
import { featureUsedEvents } from "./audit-product-events"

const ORG = Schema.decodeSync(OrgId)("org_feature_events")
const USER = Schema.decodeSync(UserId)("user_feature_events")
const ENTRY_ID = "9d2c1e3a-6a1b-4f0e-9c1d-2b3a4c5d6e7f"

const entry = (overrides: Partial<ConstructorParameters<typeof AuditLogEvent>[0]> = {}) =>
	new AuditLogEvent({
		orgId: ORG,
		id: Schema.decodeSync(AuditLogEvent.fields.id)(ENTRY_ID),
		actorType: "user",
		userId: USER,
		source: "dashboard",
		action: "slo.created",
		outcome: "allowed",
		occurredAtMs: 1_700_000_000_000,
		...overrides,
	})

describe("featureUsedEvents", () => {
	it("names the feature, action, actor and surface, attributed to the person and org", () => {
		expect(
			featureUsedEvents([entry({ source: "mcp", resourceType: "slo", resourceId: "slo_1" })]),
		).toEqual([
			{
				name: "feature_used",
				groupId: ORG,
				userId: USER,
				timestamp: 1_700_000_000_000,
				attributes: {
					feature: "slo",
					action: "created",
					source: "mcp",
					actor_type: "user",
					audit_entry_id: ENTRY_ID,
					resource_id: "slo_1",
				},
			},
		])
	})

	it("carries where an issue moved on a state change", () => {
		const [event] = featureUsedEvents([
			entry({
				action: "error_issue.state_change",
				metadata: { from_state: "open", to_state: "resolved" },
			}),
		])
		expect(event?.attributes).toMatchObject({
			feature: "error_issue",
			action: "state_change",
			to_state: "resolved",
		})
	})

	it("counts API keys and agents but not system actions, refusals, updates or reads", () => {
		const events = featureUsedEvents([
			entry({ actorType: "api_key", source: "api" }),
			entry({ actorType: "agent", source: "mcp" }),
			entry({ actorType: "system", source: "system" }),
			entry({ outcome: "denied" }),
			entry({ action: "slo.updated" }),
			entry({ action: "telemetry.read" }),
		])
		expect(Arr.map(events, (event) => event.attributes?.actor_type)).toEqual(["api_key", "agent"])
	})

	it("counts a successful MCP create as the creation its REST twin audits", () => {
		const mcpCall = (metadata: Record<string, unknown>) =>
			entry({ action: "mcp_tool.called", source: "mcp", actorType: "agent", metadata })
		const events = featureUsedEvents([
			mcpCall({ tool: "create_dashboard", is_error: false }),
			mcpCall({ tool: "manage_slo", tool_action: "create", is_error: false }),
			// A failed call, an update, and a read create nothing.
			mcpCall({ tool: "create_alert_rule", is_error: true }),
			mcpCall({ tool: "manage_slo", tool_action: "update", is_error: false }),
			mcpCall({ tool: "list_slos", is_error: false }),
		])
		expect(Arr.map(events, (event) => [event.attributes?.feature, event.attributes?.action])).toEqual([
			["dashboard", "created"],
			["slo", "created"],
		])
		expect(events[0]?.attributes?.source).toBe("mcp")
	})
})
