import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi, type TenantContext } from "@maple/domain/http"
import { Effect } from "effect"
import { AiEvaluationReadService } from "@maple/backend/services/ai-evaluations/AiEvaluationReadService"

/**
 * Dashboard-only LLM evaluation reads: the Evals tab under Agent sessions and a session's scores.
 * Every handler is the tenant plus one call into `AiEvaluationReadService`, which refuses an org
 * outside the `llmEvals` rollout and which the MCP tools read through as well.
 */
const withTenant =
	<Payload, A, E>(read: (tenant: TenantContext, payload: Payload) => Effect.Effect<A, E>) =>
	({ payload }: { readonly payload: Payload }) =>
		Effect.flatMap(CurrentTenant.Context, (tenant) => read(tenant, payload))

export const HttpAiEvaluationsInternalLive = HttpApiBuilder.group(
	MapleInternalApi,
	"aiEvaluationsInternal",
	(handlers) =>
		Effect.gen(function* () {
			const reads = yield* AiEvaluationReadService
			return handlers
				.handle("list", withTenant(reads.list))
				.handle("evaluator", withTenant(reads.evaluator))
				.handle("session", withTenant(reads.session))
		}),
)
