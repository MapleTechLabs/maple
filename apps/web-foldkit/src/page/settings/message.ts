import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/load-failure"
import { settingsTabValues } from "../../route/search"
import { ApiKeyRowSchema } from "@maple/web-data/collections/api-keys"
import * as Ingestion from "./ingestion/message"
import * as Keys from "./keys/message"
import * as Mcp from "./mcp/message"
import { SessionInfo } from "./model"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSession: { result: Schema.Result(SessionInfo, LoadFailure) },
	CompletedFetchCustomer: { result: Schema.Result(Schema.Struct({ hasByoc: Schema.Boolean }), LoadFailure) },
	ClickedTab: { tab: Schema.Literals(settingsTabValues) },
	GotMcpMessage: { message: Mcp.Message },
	GotKeysMessage: { message: Keys.Message },
	GotIngestionMessage: { message: Ingestion.Message },
	/** The `api_keys` shape (Keys and the audit log's actor names), for the org it was read for. */
	UpdatedApiKeys: { orgId: Schema.String, rows: Schema.Array(ApiKeyRowSchema) },
})
export type Message = typeof Message.Type
