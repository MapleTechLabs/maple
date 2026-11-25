import type { Permission } from "@maple/domain/policy"
import { Array as Arr } from "effect"
import { MCP_TOOL_MODULES } from "../mcp/tool-modules.generated"

/**
 * The tools that build dashboards, retired names included. Read off the generated module list, not
 * the registry, so the apply route and the session can ask without loading every tool.
 */
export const DASHBOARD_AUTHORING_TOOLS: ReadonlySet<string> = new Set(
	Arr.map(
		Arr.filter(MCP_TOOL_MODULES, (entry) => entry.permission === "dashboards:edit"),
		(entry) => entry.name,
	),
)

/**
 * What deciding a proposed call of `tool` needs: building a dashboard is `dashboards:edit`, so an
 * analyst may approve one, and every other change is acting through Maple AI (`ai:act`).
 */
export const approvalPermission = (tool: string): Permission =>
	DASHBOARD_AUTHORING_TOOLS.has(tool) ? "dashboards:edit" : "ai:act"
