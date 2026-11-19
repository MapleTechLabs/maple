import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, FeatureRequestCreated, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { FeatureRequestService } from "@maple/backend/services/feature-requests/FeatureRequestService"

export const HttpFeatureRequestsLive = HttpApiBuilder.group(MapleInternalApi, "featureRequests", (handlers) =>
	Effect.gen(function* () {
		const requests = yield* FeatureRequestService

		return handlers.handle("create", ({ payload }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				const created = yield* requests.create(tenant.orgId, tenant.userId, payload)
				return new FeatureRequestCreated(created)
			}).pipe(Effect.withSpan("HttpFeatureRequests.create")),
		)
	}),
)
