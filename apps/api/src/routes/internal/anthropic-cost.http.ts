import { HttpApiBuilder } from "effect/http-api"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { AnthropicCostConnectionService } from "@maple/backend/services/cost/AnthropicCostConnectionService"
import { removeCostConnection, saveCostConnection } from "./cost-connection-handlers"

export const HttpAnthropicCostLive = HttpApiBuilder.group(MapleInternalApi, "anthropicCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* AnthropicCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				saveCostConnection("anthropic", (orgId, userId) =>
					connections.set(orgId, userId, payload.apiKey),
				).pipe(Effect.withSpan("HttpAnthropicCost.set")),
			)
			.handle("remove", () =>
				removeCostConnection("anthropic", connections.remove).pipe(
					Effect.withSpan("HttpAnthropicCost.remove"),
				),
			)
	}),
)
