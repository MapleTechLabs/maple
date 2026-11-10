import { ApiKeyId } from "@maple/domain/http"
import { Effect } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { Message } from "./message"

export const RevokeApiKey = Command.define("RevokeApiKey", {
	args: { id: ApiKeyId },
	messages: [Message.CompletedRevoke],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			yield* client.apiKeys.revoke({ params: { id } })
		}).pipe(settleTo((result) => Message.CompletedRevoke({ id, result }))),
})
