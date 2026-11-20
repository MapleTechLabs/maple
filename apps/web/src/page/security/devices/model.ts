import { FleetDevicesResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"

// `/security/devices`: what the org's Fleet server reports about its devices (failing policies and
// vulnerable software), one read, synced hourly by the backend.

export const Devices = FleetDevicesResponse
export type Devices = typeof Devices.Type

export const Model = Schema.Struct({
	nowMs: Schema.Finite,
	devices: KeyedSchema(Devices, LoadFailure),
	/** Policies whose sample of failing devices is open. */
	expanded: Schema.Array(Schema.Number),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Finite },
	CompletedFetchDevices: { key: Schema.String, result: Schema.Result(Devices, LoadFailure) },
	ClickedRetry: {},
	ToggledPolicy: { policyId: Schema.Number },
})
export type Message = typeof Message.Type
