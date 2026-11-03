import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { describe, expect, it } from "vitest"

import { auditResourceDisplay, shortPublicId } from "./audit-log-resource"

const RULE_ID = "3f1b7c02-9a44-4d1e-8b2f-0c5d6e7a8b91"

const entry = (overrides: Partial<Parameters<typeof auditResourceDisplay>[0]>) => ({
	action: "alert_rule.updated",
	resource_type: null,
	resource_id: null,
	affected_user: null,
	metadata: null,
	...overrides,
})

describe("auditResourceDisplay", () => {
	it("names an alert rule and links to the rule by its internal id", () => {
		const display = auditResourceDisplay(
			entry({
				resource_type: "alert_rule",
				resource_id: encodePublicId(PublicIdPrefixes.alertRule, RULE_ID),
				metadata: { name: "High error rate" },
			}),
		)
		expect(display).toEqual({
			text: "Alert rule · High error rate",
			link: { to: "/alerts/$ruleId", params: { ruleId: RULE_ID } },
		})
	})

	it("falls back to a short public id when no name was recorded", () => {
		const publicId = encodePublicId(PublicIdPrefixes.dashboard, "dash-internal")
		const display = auditResourceDisplay(
			entry({ action: "dashboard.created", resource_type: "dashboard", resource_id: publicId }),
		)
		expect(display?.text).toBe(`Dashboard · ${shortPublicId(publicId)}`)
		expect(display?.link).toEqual({
			to: "/dashboards/$dashboardId",
			params: { dashboardId: "dash-internal" },
		})
	})

	it("does not link a resource that the entry deleted", () => {
		const display = auditResourceDisplay(
			entry({
				action: "alert_rule.deleted",
				resource_type: "alert_rule",
				resource_id: encodePublicId(PublicIdPrefixes.alertRule, RULE_ID),
			}),
		)
		expect(display?.link).toBeNull()
	})

	it("shows a refused request by its route", () => {
		const display = auditResourceDisplay(
			entry({
				action: "api.request",
				resource_type: "api",
				metadata: { method: "POST", path: "/v1/deployments" },
			}),
		)
		expect(display).toEqual({ text: "POST /v1/deployments", link: null })
	})

	it("uses the affected user for membership changes and links to members", () => {
		const display = auditResourceDisplay(
			entry({ action: "member.added", resource_type: "member", affected_user: "user_2Nf8abcdefgh" }),
		)
		expect(display).toEqual({
			text: "Member · user_2Nf8",
			link: { to: "/settings", search: { tab: "members" } },
		})
	})

	it("names the tool for an MCP call and the key for an ingest key roll", () => {
		expect(
			auditResourceDisplay(
				entry({
					action: "mcp_tool.called",
					resource_type: "mcp_tool",
					metadata: { tool: "search_traces" },
				}),
			)?.text,
		).toBe("MCP tool · search_traces")
		expect(
			auditResourceDisplay(
				entry({
					action: "ingest_key.rolled",
					resource_type: "ingest_key",
					metadata: { key_type: "private" },
				}),
			)?.text,
		).toBe("Ingest key · private")
	})

	it("returns null for an entry that acted on nothing", () => {
		expect(auditResourceDisplay(entry({}))).toBeNull()
	})
})
