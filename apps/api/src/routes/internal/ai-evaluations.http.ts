import { HttpApiBuilder } from "effect/http-api"
import {
	CurrentTenant,
	MapleInternalApi,
	type ListAiEvaluatorsRequest,
	type TenantContext,
} from "@maple/domain/http"
import { Effect } from "effect"
import { AiEvaluationReadService } from "@maple/backend/services/ai-evaluations/AiEvaluationReadService"
import { SessionCheckScoresService } from "@maple/backend/services/ai-evaluations/SessionCheckScoresService"

/**
 * Dashboard-only LLM evaluation reads: the Evals tab under Agent sessions and a session's scores.
 * Every handler is the tenant plus one call into `AiEvaluationReadService`, which refuses an org
 * outside the `llmEvals` rollout and which the MCP tools read through as well. An org that reads
 * its evaluators is enrolled in session-check scoring.
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
			const sessionChecks = yield* SessionCheckScoresService
			// Only after the read passed the rollout check; a failed enrollment never fails the read.
			const listAndEnroll = (tenant: TenantContext, payload: ListAiEvaluatorsRequest) =>
				reads
					.list(tenant, payload)
					.pipe(
						Effect.tap(() =>
							sessionChecks
								.enroll(tenant.orgId)
								.pipe(
									Effect.catch((error) =>
										Effect.logWarning(
											"Could not enroll the org in session-check scoring",
										).pipe(
											Effect.annotateLogs({
												orgId: tenant.orgId,
												error: error.message,
											}),
										),
									),
								),
						),
					)
			return handlers
				.handle("list", withTenant(listAndEnroll))
				.handle("evaluator", withTenant(reads.evaluator))
				.handle("session", withTenant(reads.session))
		}),
)
