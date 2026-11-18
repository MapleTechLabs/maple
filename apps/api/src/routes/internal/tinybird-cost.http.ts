import { HttpApiBuilder } from "effect/http-api"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { TinybirdCostConnectionService } from "@maple/backend/services/cost/TinybirdCostConnectionService"
import { removeCostConnection, saveCostConnection } from "./cost-connection-handlers"

export const HttpTinybirdCostLive = HttpApiBuilder.group(MapleInternalApi, "tinybirdCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* TinybirdCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				saveCostConnection("tinybird", (orgId, userId) =>
					connections.set(orgId, userId, payload.token),
				).pipe(Effect.withSpan("HttpTinybirdCost.set")),
			)
			.handle("remove", () =>
				removeCostConnection("tinybird", connections.remove).pipe(
					Effect.withSpan("HttpTinybirdCost.remove"),
				),
			)
	}),
)
