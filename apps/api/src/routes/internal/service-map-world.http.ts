import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { ServiceMapWorldService } from "@maple/backend/services/service-map/ServiceMapWorldService"

// Any org member may build the shared world; there is no admin gate.
export const HttpServiceMapWorldLive = HttpApiBuilder.group(MapleInternalApi, "serviceMapWorld", (handlers) =>
	Effect.gen(function* () {
		const world = yield* ServiceMapWorldService

		return handlers
			.handle("get", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* world.get(tenant.orgId)
				}).pipe(Effect.withSpan("HttpServiceMapWorld.get")),
			)
			.handle("apply", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return yield* world.apply(tenant.orgId, tenant.userId, payload.ops)
				}).pipe(Effect.withSpan("HttpServiceMapWorld.apply")),
			)
	}),
)
