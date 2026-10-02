import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { PrReviewAnalyticsService } from "@maple/backend/services/pr-review/PrReviewAnalyticsService"

export const HttpCodeReviewLive = HttpApiBuilder.group(MapleApi, "codeReview", (handlers) =>
	Effect.gen(function* () {
		const analytics = yield* PrReviewAnalyticsService

		return handlers
			.handle("analytics", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* analytics.analytics(tenant.orgId, query)
				}),
			)
			.handle("listReviews", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* analytics.listReviews(tenant.orgId, query)
				}),
			)
			.handle("getReview", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* analytics.getReview(tenant.orgId, params.reviewId)
				}),
			)
			.handle("listFindings", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* analytics.listFindings(tenant.orgId, query)
				}),
			)
	}),
)
