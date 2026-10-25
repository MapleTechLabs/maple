import { HttpApiBuilder } from "effect/http-api"
import { MapleAiApi, type McpToolCatalogResponse } from "@maple/domain/http"
import { Effect } from "effect"
import { mapleToolCatalogFor } from "../../mcp/tools/registry"

/** What the public MCP transport lists, so the settings page can never show a tool clients cannot call. */
export const publicMcpToolCatalog = (): McpToolCatalogResponse => ({
	tools: mapleToolCatalogFor("mcp").map((tool) => ({
		name: tool.name,
		title: tool.title,
		description: tool.description,
		readOnly: tool.hints.readOnly,
		destructive: tool.hints.destructive ?? false,
	})),
})

/** `GET /internal/mcp/tools`, the catalog behind Settings > MCP. Static per deploy. */
export const HttpMcpToolsLive = HttpApiBuilder.group(MapleAiApi, "mcpTools", (handlers) =>
	Effect.succeed(handlers.handle("list", () => Effect.succeed(publicMcpToolCatalog()))),
)
