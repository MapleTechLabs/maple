import { Context, Effect, Layer } from "effect"
import { type ListAiSessionsRequest, LlmEvalsDisabledError, type TenantContext } from "@maple/domain/http"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
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
 * call needs only its tenant and request. The list's evaluation filter is refused outside the
 * `llmEvals` rollout.
 */
const make = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService
	const featureFlags = yield* OrganizationFeatureFlagsService
	const bind = bindWarehouse(warehouse)
	const list = bind(listAiSessions)
	return {
		resolveWindow: bind(resolveAiSessionWindow),
		list: Effect.fn("AiSessionReads.listGated")(function* (
			tenant: TenantContext,
			payload: ListAiSessionsRequest,
		) {
			if (payload.evaluation !== undefined) {
				const flags = yield* featureFlags.flags(tenant.orgId)
				if (!flags.llmEvals) {
					return yield* new LlmEvalsDisabledError({
						message:
							"Filtering sessions by evaluation score needs LLM evals, which are not enabled for this organization.",
					})
				}
			}
			return yield* list(tenant, payload)
		}),
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
	/** Needs `OrganizationFeatureFlagsService` from the app root. */
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
