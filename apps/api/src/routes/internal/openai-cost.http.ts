import { HttpApiBuilder } from "effect/http-api"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { OpenAiCostConnectionService } from "@maple/backend/services/cost/OpenAiCostConnectionService"
import { removeCostConnection, saveCostConnection } from "./cost-connection-handlers"

export const HttpOpenAiCostLive = HttpApiBuilder.group(MapleInternalApi, "openaiCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* OpenAiCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				saveCostConnection("openai", (orgId, userId) =>
					connections.set(orgId, userId, payload.apiKey),
				).pipe(Effect.withSpan("HttpOpenAiCost.set")),
			)
			.handle("remove", () =>
				removeCostConnection("openai", connections.remove).pipe(
					Effect.withSpan("HttpOpenAiCost.remove"),
				),
			)
	}),
)
