import { Context, Effect, Layer } from "effect"
import { bindWarehouse } from "@maple/backend/services/warehouse/bind-warehouse"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	listAiSessions,
	readAiSessionDetails,
	readAiSessionDistributions,
	readAiSessionFacets,
	readAiSessionSpans,
	readAiSessionSummary,
	readAiToolErrorDetail,
	readAiToolErrorSamples,
	readAiToolErrors,
	readAiToolsBreakdowns,
	readAiToolsSeries,
	readAiToolsTotals,
	resolveAiSessionWindow,
} from "./ai-session-reads"

/**
 * The agent session reads (Agent Sessions page, MCP tools): the warehouse is captured here, so a
 * call needs only its tenant and request.
 */
const make = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService
	const bind = bindWarehouse(warehouse)
	return {
		resolveWindow: bind(resolveAiSessionWindow),
		list: bind(listAiSessions),
		details: bind(readAiSessionDetails),
		facets: bind(readAiSessionFacets),
		distributions: bind(readAiSessionDistributions),
		spans: bind(readAiSessionSpans),
		summary: bind(readAiSessionSummary),
		toolsSeries: bind(readAiToolsSeries),
		toolsTotals: bind(readAiToolsTotals),
		toolsBreakdowns: bind(readAiToolsBreakdowns),
		toolErrors: bind(readAiToolErrors),
		toolErrorDetail: bind(readAiToolErrorDetail),
		toolErrorSamples: bind(readAiToolErrorSamples),
	}
})

export class AiSessionReadService extends Context.Service<AiSessionReadService>()(
	"@maple/backend/services/ai-sessions/AiSessionReadService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
