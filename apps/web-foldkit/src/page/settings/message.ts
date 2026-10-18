import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/load-failure"
import { settingsTabValues } from "../../route/search"
import * as Mcp from "./mcp/message"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSession: { result: Schema.Result(Schema.Struct({ isAdmin: Schema.Boolean }), LoadFailure) },
	CompletedFetchCustomer: { result: Schema.Result(Schema.Struct({ hasByoc: Schema.Boolean }), LoadFailure) },
	ClickedTab: { tab: Schema.Literals(settingsTabValues) },
	GotMcpMessage: { message: Mcp.Message },
})
export type Message = typeof Message.Type
