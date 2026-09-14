import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
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
import type { TenantContext } from "@maple/backend/services/auth/AuthService"

/**
 * Dashboard-only AI agent session reads.
 *
 * Serves the Agent Sessions page. Scoping is `CurrentTenant`, like every other
 * warehouse read.
 *
 * Every handler is the tenant plus one call into `ai-session-reads`, which the
 * MCP tools read through as well: the reads and their spans live there.
 */
const withTenant =
	<Payload, A, E, R>(read: (tenant: TenantContext, payload: Payload) => Effect.Effect<A, E, R>) =>
	({ payload }: { readonly payload: Payload }) =>
		Effect.flatMap(CurrentTenant.Context, (tenant) => read(tenant, payload))

export const HttpAiSessionsInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"aiSessionsInternal",
	(handlers) =>
		handlers
			.handle("list", withTenant(listAiSessions))
			.handle("details", withTenant(readAiSessionDetails))
			.handle("facets", withTenant(readAiSessionFacets))
			.handle("distributions", withTenant(readAiSessionDistributions))
			.handle("spans", withTenant(readAiSessionSpans))
			.handle("summary", withTenant(readAiSessionSummary))
			.handle("toolsSeries", withTenant(readAiToolsSeries))
			.handle("toolsTotals", withTenant(readAiToolsTotals))
			.handle("toolsBreakdowns", withTenant(readAiToolsBreakdowns))
			.handle("toolErrors", withTenant(readAiToolErrors))
			.handle("toolErrorDetail", withTenant(readAiToolErrorDetail))
			.handle("toolErrorSamples", withTenant(readAiToolErrorSamples)),
)
