import { HttpApiBuilder } from "effect/http-api"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { CloudflareCostConnectionService } from "@maple/backend/services/cost/CloudflareCostConnectionService"
import { removeCostConnection, saveCostConnection } from "./cost-connection-handlers"

export const HttpCloudflareCostLive = HttpApiBuilder.group(MapleInternalApi, "cloudflareCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* CloudflareCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				saveCostConnection("cloudflare", (orgId, userId) =>
					connections.set(orgId, userId, payload.apiToken),
				).pipe(Effect.withSpan("HttpCloudflareCost.set")),
			)
			.handle("remove", () =>
				removeCostConnection("cloudflare", connections.remove).pipe(
					Effect.withSpan("HttpCloudflareCost.remove"),
				),
			)
	}),
)
