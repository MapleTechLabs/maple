import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { definePage } from "../../contract"
import { Message as SettingsMessage } from "../message"
import * as McpMessage from "../mcp/message"
import * as McpModel from "../mcp/model"
import { pageCode } from "../../code"

export const Model = Schema.Struct({ nowMs: Schema.Number, isAdmin: Schema.Boolean, mcp: McpModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotSettingsMessage: { message: SettingsMessage },
	GotMcpMessage: { message: McpMessage.Message },
})
export type Message = typeof Message.Type

/** `/mcp`: the same `McpSection` as `/settings?tab=mcp`, standalone. */
export const entry = definePage("McpPage", { Model, Message }, { routes: ["Mcp"] })

export const page = entry.lazy(pageCode.McpPage)
