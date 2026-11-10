import { HttpApiBuilder } from "effect/http-api"
import { Effect } from "effect"
import { MapleApi } from "@maple/domain/http"
import { StatusPageSubscriptionsService } from "@maple/backend/services/status-pages/StatusPageSubscriptionsService"

// Unauthenticated by design: the status Worker forwards a visitor's form here. Tokens arrive in
// the body, so the auto server span records no credential.
export const HttpStatusPageSubscriptionsPublicLive = HttpApiBuilder.group(
	MapleApi,
	"statusPageSubscriptions",
	(handlers) =>
		Effect.gen(function* () {
			const subscriptions = yield* StatusPageSubscriptionsService
			return handlers
				.handle("subscribe", ({ params, payload }) => subscriptions.subscribe(params.pageId, payload))
				.handle("confirm", ({ params, payload }) =>
					subscriptions.confirm(params.pageId, payload.token),
				)
				.handle("unsubscribe", ({ params, payload }) =>
					subscriptions.unsubscribe(params.pageId, payload.token),
				)
		}),
)
