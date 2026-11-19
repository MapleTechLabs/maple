import { HttpApiBuilder } from "effect/http-api"
import { CostSourceRequested, CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { CostSourceRequestService } from "@maple/backend/services/cost/CostSourceRequestService"

// Any member who can open the Add source dialog may ask: a request changes nothing in the org.
export const HttpCostSourceRequestsLive = HttpApiBuilder.group(
	MapleInternalApi,
	"costSourceRequests",
	(handlers) =>
		Effect.gen(function* () {
			const requests = yield* CostSourceRequestService

			return handlers.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const created = yield* requests.create(tenant.orgId, tenant.userId, payload)
					return new CostSourceRequested(created)
				}).pipe(Effect.withSpan("HttpCostSourceRequests.create")),
			)
		}),
)
