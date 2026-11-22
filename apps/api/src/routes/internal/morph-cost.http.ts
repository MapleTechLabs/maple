import { HttpApiBuilder } from "effect/http-api"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { MorphCostConnectionService } from "@maple/backend/services/cost/MorphCostConnectionService"
import { removeCostConnection, saveCostConnection } from "./cost-connection-handlers"

export const HttpMorphCostLive = HttpApiBuilder.group(MapleInternalApi, "morphCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* MorphCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				saveCostConnection("morph", (orgId, userId) =>
					connections.set(orgId, userId, payload.apiKey),
				).pipe(Effect.withSpan("HttpMorphCost.set")),
			)
			.handle("remove", () =>
				removeCostConnection("morph", connections.remove).pipe(
					Effect.withSpan("HttpMorphCost.remove"),
				),
			)
	}),
)
