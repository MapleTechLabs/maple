import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { DigestService } from "@maple/backend/services/digest/DigestService"
import { WebAnalyticsDigestService } from "@maple/backend/services/digest/WebAnalyticsDigestService"

export const HttpDigestLive = HttpApiBuilder.group(MapleInternalApi, "digest", (handlers) =>
	Effect.gen(function* () {
		const digest = yield* DigestService
		const webAnalyticsDigest = yield* WebAnalyticsDigestService

		return handlers
			.handle("getSubscription", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* digest.getSubscription(tenant.orgId, tenant.userId)
				}),
			)
			.handle("upsertSubscription", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* digest.upsertSubscription(tenant.orgId, tenant.userId, {
						email: payload.email,
						enabled: payload.enabled,
						dayOfWeek: payload.dayOfWeek,
						timezone: payload.timezone,
						namespaces: payload.namespaces,
						environments: payload.environments,
						webAnalyticsEnabled: payload.webAnalyticsEnabled,
					})
				}),
			)
			.handle("deleteSubscription", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* digest.deleteSubscription(tenant.orgId, tenant.userId)
				}),
			)
			.handle("preview", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* digest.preview(tenant.orgId, tenant.userId)
				}),
			)
			.handle("previewWebAnalytics", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* webAnalyticsDigest.preview(tenant.orgId)
				}),
			)
	}),
)
