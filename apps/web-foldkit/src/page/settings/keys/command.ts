import { ApiKeyId } from "@maple/domain/http"
import { Effect } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { Message } from "./message"
import { IngestKeyType } from "./model"

/** `retainedQueryV2("ingestKeys", "retrieve", {})`, admins only. */
export const FetchIngestKeys = Command.define("FetchIngestKeys", {
	messages: [Message.CompletedFetchIngestKeys],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.ingestKeys.retrieve()
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchIngestKeys({ result })),
	),
})

export const RevokeApiKey = Command.define("RevokeApiKey", {
	args: { id: ApiKeyId },
	messages: [Message.CompletedRevoke],
	execute: ({ id }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			yield* client.apiKeys.revoke({ params: { id } })
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedRevoke({ id, result })),
		),
})

export const RollIngestKey = Command.define("RollIngestKey", {
	args: { type: IngestKeyType },
	messages: [Message.CompletedIngestRoll],
	execute: ({ type }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			yield* type === "ingest_public" ? client.ingestKeys.rollPublic() : client.ingestKeys.rollPrivate()
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedIngestRoll({ type, result })),
		),
})
