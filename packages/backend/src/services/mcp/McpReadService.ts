import { Context, Effect, Layer } from "effect"
import { bindWarehouse } from "@maple/backend/services/warehouse/bind-warehouse"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { readMcpOverview, readMcpServers, readMcpSession, readMcpSessions, readMcpTool } from "./mcp-reads"

/** The MCP hub's reads (`/mcp-servers`): the warehouse is captured here, so a call needs only its tenant and request. */
const make = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService
	const bind = bindWarehouse(warehouse)
	return {
		servers: bind(readMcpServers),
		overview: bind(readMcpOverview),
		tool: bind(readMcpTool),
		sessions: bind(readMcpSessions),
		session: bind(readMcpSession),
	}
})

export class McpReadService extends Context.Service<McpReadService>()(
	"@maple/backend/services/mcp/McpReadService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
