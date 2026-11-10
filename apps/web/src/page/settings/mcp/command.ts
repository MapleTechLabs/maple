import { McpConnectionPublicId } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { MapleAiClient, MapleApiV2Client } from "../../../platform/api-clients"
import { Message } from "./message"

export const FetchConnections = Command.define("FetchMcpConnections", {
	messages: [Message.CompletedFetchConnections],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const page = yield* client.mcpConnections.list({ query: { limit: 100 } })
		return page.data
	}).pipe(settleTo((result) => Message.CompletedFetchConnections({ result }))),
})

export const FetchTools = Command.define("FetchMcpTools", {
	messages: [Message.CompletedFetchTools],
	execute: Effect.gen(function* () {
		const client = yield* MapleAiClient
		const catalog = yield* client.mcpTools.list()
		return catalog.tools
	}).pipe(settleTo((result) => Message.CompletedFetchTools({ result }))),
})

export const RevokeConnection = Command.define("RevokeMcpConnection", {
	args: { connectionId: McpConnectionPublicId },
	messages: [Message.CompletedRevoke],
	execute: ({ connectionId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			yield* client.mcpConnections.revoke({ params: { id: connectionId } })
		}).pipe(settleTo((result) => Message.CompletedRevoke({ result }))),
})
