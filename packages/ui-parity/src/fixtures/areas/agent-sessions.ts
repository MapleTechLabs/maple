import { Effect, Schema } from "effect"
import {
	AiToolErrorDetailRequest,
	AiToolErrorDetailResponse,
	AiToolErrorSamplesRequest,
	AiToolErrorSamplesResponse,
	AiToolErrorsRequest,
	AiToolErrorsResponse,
	AiToolsBreakdownsRequest,
	AiToolsBreakdownsResponse,
	AiToolsSeriesRequest,
	AiToolsSeriesResponse,
	AiToolsTotalsRequest,
	AiToolsTotalsResponse,
	GetAiSessionSpansRequest,
	GetAiSessionSpansResponse,
	GetAiSessionSummaryRequest,
	GetAiSessionSummaryResponse,
	ListAiSessionDetailsRequest,
	ListAiSessionDetailsResponse,
	ListAiSessionsDistributionsRequest,
	ListAiSessionsDistributionsResponse,
	ListAiSessionsFacetsRequest,
	ListAiSessionsFacetsResponse,
	ListAiSessionsRequest,
	ListAiSessionsResponse,
} from "@maple/domain/http"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
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
} from "@maple/backend/services/ai-sessions/ai-session-reads"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { tenantFor } from "../../backend/middleware.ts"
import type { FixtureWarehouse } from "../../backend/warehouse.ts"
import type { FixtureArea } from "../areas.ts"
import type { Dataset, EndpointHandler } from "../dataset.ts"
import { acmeAdmin, FROZEN_NOW } from "../identity.ts"
import { agentSessionsTelemetry } from "../telemetry/agent-sessions.ts"

/**
 * `aiSessionsInternal.*` (apps/api/src/routes/internal/ai-sessions.http.ts): each handler is the
 * tenant plus one real `ai-session-reads` call, run here on the fixture warehouse. Only the
 * `agent-sessions` org has agent spans, so every other dataset gets the real empty answers.
 */

export const AGENT_SESSIONS_DATASET = "agent-sessions"

class ParityAgentSessionsPayloadError extends Schema.TaggedError<ParityAgentSessionsPayloadError>()(
	"@maple/ui-parity/ParityAgentSessionsPayloadError",
	{ message: Schema.String },
) {}

const read =
	<P, A, I, E>(
		warehouse: FixtureWarehouse,
		request: Schema.Codec<P, unknown>,
		response: Schema.Codec<A, I>,
		run: (tenant: TenantContext, payload: P) => Effect.Effect<A, E, WarehouseQueryService>,
	): EndpointHandler =>
	({ dataset, payload }) =>
		Effect.gen(function* () {
			const tenant = tenantFor(dataset)
			if (tenant === undefined || !Schema.is(request)(payload))
				return yield* new ParityAgentSessionsPayloadError({ message: "no tenant, or the payload does not match" })
			const result = yield* run(tenant, payload).pipe(Effect.provideService(WarehouseQueryService, warehouse.executor))
			return yield* Schema.encodeUnknownEffect(response)(result)
		})

const endpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"aiSessionsInternal.list": read(warehouse, ListAiSessionsRequest, ListAiSessionsResponse, listAiSessions),
	"aiSessionsInternal.details": read(warehouse, ListAiSessionDetailsRequest, ListAiSessionDetailsResponse, readAiSessionDetails),
	"aiSessionsInternal.facets": read(warehouse, ListAiSessionsFacetsRequest, ListAiSessionsFacetsResponse, readAiSessionFacets),
	"aiSessionsInternal.distributions": read(
		warehouse,
		ListAiSessionsDistributionsRequest,
		ListAiSessionsDistributionsResponse,
		readAiSessionDistributions,
	),
	"aiSessionsInternal.spans": read(warehouse, GetAiSessionSpansRequest, GetAiSessionSpansResponse, readAiSessionSpans),
	"aiSessionsInternal.summary": read(warehouse, GetAiSessionSummaryRequest, GetAiSessionSummaryResponse, readAiSessionSummary),
	"aiSessionsInternal.toolsSeries": read(warehouse, AiToolsSeriesRequest, AiToolsSeriesResponse, readAiToolsSeries),
	"aiSessionsInternal.toolsTotals": read(warehouse, AiToolsTotalsRequest, AiToolsTotalsResponse, readAiToolsTotals),
	"aiSessionsInternal.toolsBreakdowns": read(warehouse, AiToolsBreakdownsRequest, AiToolsBreakdownsResponse, readAiToolsBreakdowns),
	"aiSessionsInternal.toolErrors": read(warehouse, AiToolErrorsRequest, AiToolErrorsResponse, readAiToolErrors),
	"aiSessionsInternal.toolErrorDetail": read(warehouse, AiToolErrorDetailRequest, AiToolErrorDetailResponse, readAiToolErrorDetail),
	"aiSessionsInternal.toolErrorSamples": read(
		warehouse,
		AiToolErrorSamplesRequest,
		AiToolErrorSamplesResponse,
		readAiToolErrorSamples,
	),
})

/** Acme's AI team: the same admin in an org whose only telemetry is agent sessions. */
const agentSessionsDataset: Dataset = {
	name: AGENT_SESSIONS_DATASET,
	now: FROZEN_NOW,
	identity: { ...acmeAdmin, orgId: "org_parity_agents", orgName: "Acme AI", orgSlug: "acme-ai" },
	auth: "self_hosted",
	endpoints: {},
	synced: {},
	telemetry: agentSessionsTelemetry({ orgId: "org_parity_agents", now: new Date(FROZEN_NOW) }),
}

export const fixtureArea: FixtureArea = {
	area: "agent-sessions",
	endpoints,
	datasets: [agentSessionsDataset],
}
