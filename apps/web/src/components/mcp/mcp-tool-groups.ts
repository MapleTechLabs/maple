import type { McpToolCatalogEntry } from "@maple/domain/http"
import { Array as Arr, String as Str } from "effect"

export type McpToolGroupId =
	| "alerts"
	| "dashboards"
	| "errors"
	| "traces"
	| "logs"
	| "services"
	| "query"
	| "agents"
	| "sessions"
	| "infrastructure"
	| "source"
	| "setup"
	| "other"

/** Display order, and each group's label. */
export const MCP_TOOL_GROUPS: ReadonlyArray<{ readonly id: McpToolGroupId; readonly label: string }> = [
	{ id: "alerts", label: "Alerts" },
	{ id: "dashboards", label: "Dashboards" },
	{ id: "errors", label: "Errors" },
	{ id: "traces", label: "Traces" },
	{ id: "logs", label: "Logs" },
	{ id: "services", label: "Services" },
	{ id: "query", label: "Query and metrics" },
	{ id: "agents", label: "AI agents" },
	{ id: "sessions", label: "Sessions" },
	{ id: "infrastructure", label: "Infrastructure" },
	{ id: "source", label: "Source code and CI" },
	{ id: "setup", label: "Ingest and setup" },
	{ id: "other", label: "Other" },
]

/**
 * Name tokens that place a tool, first match wins. The order settles overlaps:
 * `get_agent_session` is an agent tool, `list_error_incidents` an error tool, `get_session_traces`
 * a session tool.
 */
const RULES: ReadonlyArray<readonly [McpToolGroupId, ReadonlyArray<string>]> = [
	["agents", ["agent"]],
	["sessions", ["session", "sessions"]],
	["errors", ["error", "errors", "issue", "issues", "fix"]],
	["alerts", ["alert", "incident"]],
	["dashboards", ["dashboard", "dashboards", "widget", "widgets", "chart"]],
	["traces", ["trace", "traces", "span"]],
	["logs", ["log", "logs"]],
	["source", ["source", "ci", "commits", "pull"]],
	["infrastructure", ["infra", "railway"]],
	["setup", ["ingest", "setup", "integrations", "instrumentation", "scrape"]],
	["services", ["service", "services", "periods", "route"]],
	["query", ["query", "data", "sql", "metrics", "attributes", "warehouse", "funnel", "product"]],
]

export function mcpToolGroupOf(name: string): McpToolGroupId {
	const tokens = new Set(Str.split("_")(Str.toLowerCase(name)))
	const rule = RULES.find(([, words]) => Arr.some(words, (word) => tokens.has(word)))
	return rule === undefined ? "other" : rule[0]
}

export interface McpToolGroup {
	readonly id: McpToolGroupId
	readonly label: string
	readonly tools: ReadonlyArray<McpToolCatalogEntry>
}

const matches = (tool: McpToolCatalogEntry, needle: string) =>
	Arr.some([tool.name, tool.title, tool.description], (field) =>
		Str.includes(needle)(Str.toLowerCase(field)),
	)

/**
 * Tools grouped by topic in display order, empty groups dropped. Within a group reads come
 * before writes, then by name. `search` matches name, title or description.
 */
export function groupMcpTools(
	tools: ReadonlyArray<McpToolCatalogEntry>,
	search = "",
): ReadonlyArray<McpToolGroup> {
	const needle = Str.toLowerCase(Str.trim(search))
	const visible = needle === "" ? tools : Arr.filter(tools, (tool) => matches(tool, needle))
	return Arr.flatMap(MCP_TOOL_GROUPS, ({ id, label }) => {
		const members = Arr.filter(visible, (tool) => mcpToolGroupOf(tool.name) === id)
		if (members.length === 0) return []
		const sorted = members.toSorted(
			(a, b) => Number(b.readOnly) - Number(a.readOnly) || Str.localeCompare(b.name)(a.name),
		)
		return [{ id, label, tools: sorted }]
	})
}
