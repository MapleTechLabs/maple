import { SecurityExposureResponse, SecurityRuntimesResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"

// `/security/exposure` and `/security/runtimes` as one page instance: each tab reads its own
// endpoint the first time it shows, and a tab change keeps what either has read.

export const Tab = Schema.Literals(["exposure", "runtimes"])
export type Tab = typeof Tab.Type

export const Exposure = SecurityExposureResponse.fields.data
export type Exposure = typeof Exposure.Type
export const Runtimes = SecurityRuntimesResponse.fields.data
export type Runtimes = typeof Runtimes.Type

export const Model = Schema.Struct({
	tab: Tab,
	nowMs: Schema.Finite,
	exposure: KeyedSchema(Exposure, LoadFailure),
	runtimes: KeyedSchema(Runtimes, LoadFailure),
})
export type Model = typeof Model.Type

const result = <S extends Schema.Top>(schema: S) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Finite },
	CompletedFetchExposure: result(Exposure),
	CompletedFetchRuntimes: result(Runtimes),
	ClickedRetry: {},
})
export type Message = typeof Message.Type
