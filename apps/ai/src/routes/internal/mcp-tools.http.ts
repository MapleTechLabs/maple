import { HttpApiBuilder } from "effect/http-api"
import { MapleAiApi, type McpToolCatalogResponse } from "@maple/domain/http"
import { Effect, Array as Arr } from "effect"
import { MCP_TOOL_DESCRIPTORS } from "../../mcp/tool-descriptors.generated"

/** What the public MCP transport lists, so the settings page can never show a tool clients cannot call. */
export const publicMcpToolCatalog = (): McpToolCatalogResponse => ({
	tools: Arr.map(MCP_TOOL_DESCRIPTORS, (tool) => ({
		name: tool.name,
		title: tool.title,
		description: tool.description,
		readOnly: tool.annotations?.readOnlyHint ?? false,
		destructive: tool.annotations?.destructiveHint ?? false,
	})),
})

/** `GET /internal/mcp/tools`, the catalog behind Settings > MCP. Static per deploy. */
export const HttpMcpToolsLive = HttpApiBuilder.group(MapleAiApi, "mcpTools", (handlers) =>
	Effect.succeed(handlers.handle("list", () => Effect.succeed(publicMcpToolCatalog()))),
)
