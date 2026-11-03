import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"

/** One tool a third-party MCP client can call, as the settings page lists it. */
export const McpToolCatalogEntry = Schema.Struct({
	name: Schema.String,
	title: Schema.String,
	description: Schema.String,
	/** Nothing in the org changes. */
	readOnly: Schema.Boolean,
	/** Can remove or overwrite something the caller cannot restore. */
	destructive: Schema.Boolean,
})
export type McpToolCatalogEntry = Schema.Schema.Type<typeof McpToolCatalogEntry>

export const McpToolCatalogResponse = Schema.Struct({
	tools: Schema.Array(McpToolCatalogEntry),
})
export type McpToolCatalogResponse = Schema.Schema.Type<typeof McpToolCatalogResponse>

/** The public MCP tool catalog, served by the AI Worker that owns the registry. Dashboard only. */
export class McpToolsApiGroup extends HttpApiGroup.make("mcpTools")
	.add(
		HttpApiEndpoint.get("list", "/tools", {
			success: McpToolCatalogResponse,
		}),
	)
	.prefix("/internal/mcp")
	.middleware(SessionAuthorization) {}
