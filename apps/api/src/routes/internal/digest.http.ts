import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, DigestEmailUnavailableError, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DigestService } from "@maple/backend/services/digest/DigestService"
import { WebAnalyticsDigestService } from "@maple/backend/services/digest/WebAnalyticsDigestService"

export const HttpDigestLive = HttpApiBuilder.group(MapleInternalApi, "digest", (handlers) =>
	Effect.gen(function* () {
		const auth = yield* AuthService
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
					// The address is never taken from the request: only the member's own verified one.
					const email = yield* auth.getVerifiedPrimaryEmail(tenant.userId)
					if (email === null) {
						return yield* new DigestEmailUnavailableError({
							message:
								"Your account has no verified primary email address to send the digest to",
						})
					}
					return yield* digest.upsertSubscription(tenant.orgId, tenant.userId, {
						email,
						enabled: payload.enabled,
						dayOfWeek: payload.dayOfWeek,
						sendHour: payload.sendHour,
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
