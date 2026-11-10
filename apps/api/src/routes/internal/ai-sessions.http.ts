import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi, type TenantContext } from "@maple/domain/http"
import { Effect } from "effect"
import { AiSessionReadService } from "@maple/backend/services/ai-sessions/AiSessionReadService"

/**
 * Dashboard-only AI agent session reads.
 *
 * Serves the Agent Sessions page. Scoping is `CurrentTenant`, like every other
 * warehouse read.
 *
 * Every handler is the tenant plus one call into `AiSessionReadService`, which the
 * MCP tools read through as well.
 */
const withTenant =
	<Payload, A, E>(read: (tenant: TenantContext, payload: Payload) => Effect.Effect<A, E>) =>
	({ payload }: { readonly payload: Payload }) =>
		Effect.flatMap(CurrentTenant.Context, (tenant) => read(tenant, payload))

export const HttpAiSessionsInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"aiSessionsInternal",
	(handlers) =>
		Effect.gen(function* () {
			const reads = yield* AiSessionReadService
			return handlers
				.handle("list", withTenant(reads.list))
				.handle("details", withTenant(reads.details))
				.handle("facets", withTenant(reads.facets))
				.handle("distributions", withTenant(reads.distributions))
				.handle("spans", withTenant(reads.spans))
				.handle("summary", withTenant(reads.summary))
				.handle("toolsSeries", withTenant(reads.toolsSeries))
				.handle("toolsTotals", withTenant(reads.toolsTotals))
				.handle("toolsBreakdowns", withTenant(reads.toolsBreakdowns))
				.handle("toolErrors", withTenant(reads.toolErrors))
				.handle("toolErrorDetail", withTenant(reads.toolErrorDetail))
				.handle("toolErrorSamples", withTenant(reads.toolErrorSamples))
		}),
)
