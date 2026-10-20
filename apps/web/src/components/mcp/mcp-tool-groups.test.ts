import { describe, expect, it } from "vitest"
import type { McpToolCatalogEntry } from "@maple/domain/http"
import { groupMcpTools, mcpToolGroupOf } from "./mcp-tool-groups"

const tool = (name: string, readOnly = true, description = ""): McpToolCatalogEntry => ({
	name,
	title: name,
	description,
	readOnly,
	destructive: false,
})

describe("mcpToolGroupOf", () => {
	it("groups by the topic named in the tool's name", () => {
		expect(mcpToolGroupOf("create_alert_rule")).toBe("alerts")
		expect(mcpToolGroupOf("add_dashboard_widget")).toBe("dashboards")
		expect(mcpToolGroupOf("search_logs")).toBe("logs")
		expect(mcpToolGroupOf("list_infra")).toBe("infrastructure")
	})

	it("resolves names that mention two topics by the more specific one", () => {
		expect(mcpToolGroupOf("get_agent_session_transcript")).toBe("agents")
		expect(mcpToolGroupOf("list_error_incidents")).toBe("errors")
		expect(mcpToolGroupOf("get_incident_timeline")).toBe("alerts")
		expect(mcpToolGroupOf("get_session_traces")).toBe("sessions")
		expect(mcpToolGroupOf("ingest_usage")).toBe("setup")
	})

	it("matches whole tokens, not substrings", () => {
		expect(mcpToolGroupOf("catalog_lookup")).toBe("other")
	})
})

describe("groupMcpTools", () => {
	const catalog = [
		tool("delete_alert_rule", false),
		tool("list_alert_rules"),
		tool("search_logs", true, "Search and filter logs by severity"),
		tool("create_dashboard", false),
	]

	it("returns groups in display order with reads before writes", () => {
		const groups = groupMcpTools(catalog)
		expect(groups.map((group) => group.label)).toEqual(["Alerts", "Dashboards", "Logs"])
		expect(groups[0]?.tools.map((t) => t.name)).toEqual(["list_alert_rules", "delete_alert_rule"])
	})

	it("filters on name, title and description, dropping empty groups", () => {
		expect(groupMcpTools(catalog, "SEVERITY").map((group) => group.id)).toEqual(["logs"])
		expect(groupMcpTools(catalog, "nothing matches")).toEqual([])
	})
})
