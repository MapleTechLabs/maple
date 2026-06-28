import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { InvestigationService } from "../services/InvestigationService"

/**
 * Internal `submit_diagnosis` write the chat-flue investigate agent posts once
 * it finishes its diagnostic pass:
 *
 *   POST /api/internal/investigations/:id/diagnosis
 *
 * Server-to-server, authed by the internal-service token via the
 * `InternalServiceAuthorization` middleware (see InternalServiceAuthorizationLayer),
 * which provides the same `CurrentTenant.Context` the Clerk-authed groups use — so
 * a service caller can only write investigations in the org it resolves to.
 *
 * The framework owns the boilerplate: `:id`/payload decode (→ 400), auth (→ 401),
 * and the declared `InvestigationNotFoundError`/`InvestigationPersistenceError`
 * → 404/503 mapping (via their `httpApiStatus`). The handler is just the write.
 */
export const HttpInvestigationsInternalLive = HttpApiBuilder.group(
	MapleApi,
	"investigationsInternal",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* InvestigationService

			return handlers.handle("submitDiagnosis", ({ params, payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, investigationId: params.id })
					return yield* service.submitDiagnosis(tenant.orgId, params.id, payload)
				}).pipe(Effect.withSpan("HttpInvestigationsInternal.submitDiagnosis")),
			)
		}),
)
