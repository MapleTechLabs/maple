import { Effect } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { Message } from "./message"

/** This cycle's AI credits by surface, model and code review (the API resolves the cycle). */
export const FetchAiCreditUsage = Command.define("FetchAiCreditUsage", {
	messages: [Message.CompletedFetchUsage],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.billing.getAiCreditUsage()).pipe(
		settleTo((result) => Message.CompletedFetchUsage({ result })),
	),
})
