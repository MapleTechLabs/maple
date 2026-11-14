import { describe, expect, it } from "@effect/vitest"
import { suggestToolNames, unknownToolMessage } from "./tool-suggestions"

const TOOLS = [
	"list_uptime_monitors",
	"create_uptime_monitor",
	"list_alert_incidents",
	"acknowledge_alert_incident",
	"get_incident_timeline",
	"search_traces",
	"inspect_trace",
	"list_alert_rules",
]

describe("suggestToolNames", () => {
	// Names agents sent in production that matched no tool.
	it("finds the tool behind a name missing its verb", () => {
		expect(suggestToolNames("uptime_monitors", TOOLS)[0]).toBe("list_uptime_monitors")
	})

	it("reads a REST path as the tool for the same resource", () => {
		expect(suggestToolNames("GET /v2/uptime_monitors", TOOLS)[0]).toBe("list_uptime_monitors")
	})

	it("offers the incident tools for a singular incident getter", () => {
		expect(suggestToolNames("get_alert_incident", TOOLS)).toEqual(
			expect.arrayContaining(["list_alert_incidents", "acknowledge_alert_incident"]),
		)
	})

	it("catches a misspelling", () => {
		expect(suggestToolNames("serch_traces", TOOLS)[0]).toBe("search_traces")
	})

	it("suggests nothing for a CLI flag", () => {
		expect(suggestToolNames("--help", TOOLS)).toEqual([])
	})
})

describe("unknownToolMessage", () => {
	it("always says where the full list is", () => {
		expect(unknownToolMessage("--help", TOOLS)).toBe(
			"Unknown tool `--help`. Call tools/list to see the available tools.",
		)
		expect(unknownToolMessage("uptime_monitors", TOOLS)).toContain("tools/list has every tool")
	})
})
