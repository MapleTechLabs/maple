import { McpConnectionPublicId } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleAiClient, MapleApiV2Client } from "../../../platform/api-clients"
import { Message } from "./message"

/** `retainedQueryV2("mcpConnections", "list", { query: { limit: 100 } })`. */
export const FetchConnections = Command.define("FetchMcpConnections", {
	messages: [Message.CompletedFetchConnections],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const page = yield* client.mcpConnections.list({ query: { limit: 100 } })
		return page.data
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchConnections({ result })),
	),
})

/** `MapleAiAtomClient.query("mcpTools", "list")`. */
export const FetchTools = Command.define("FetchMcpTools", {
	messages: [Message.CompletedFetchTools],
	execute: Effect.gen(function* () {
		const client = yield* MapleAiClient
		const catalog = yield* client.mcpTools.list()
		return catalog.tools
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchTools({ result })),
	),
})

export const RevokeConnection = Command.define("RevokeMcpConnection", {
	args: { connectionId: McpConnectionPublicId },
	messages: [Message.CompletedRevoke],
	execute: ({ connectionId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			yield* client.mcpConnections.revoke({ params: { id: connectionId } })
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedRevoke({ result })),
		),
})
