import { DevicesResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"

// `/security/devices`: what the org's device management tools report about its devices (failing
// policies and vulnerable software), merged across sources in one read, synced hourly by the backend.

export const Devices = DevicesResponse
export type Devices = typeof Devices.Type

export const Model = Schema.Struct({
	nowMs: Schema.Finite,
	devices: KeyedSchema(Devices, LoadFailure),
	/** Policies whose sample of failing devices is open, by `source:connectionId:policyId`. */
	expanded: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Finite },
	CompletedFetchDevices: { key: Schema.String, result: Schema.Result(Devices, LoadFailure) },
	ClickedRetry: {},
	ToggledPolicy: { key: Schema.String },
})
export type Message = typeof Message.Type
