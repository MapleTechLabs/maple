import * as ServiceMap from "@maple/web-foldkit/service-map/map/service-map"
import * as CopyButton from "@maple/web-foldkit/ui/copy-button"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/local-query"
import { LocalServiceMapDataSchema } from "./fetch"
import { Stored } from "./model"

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	CompletedReadStored: { stored: Stored },
	SucceededFetchServiceMap: { key: Schema.String, data: LocalServiceMapDataSchema, fetchedAtMs: Schema.Number },
	FailedFetchServiceMap: { key: Schema.String, failure: LoadFailure },
	ClickedRefresh: {},
	ClickedRetry: {},
	CompletedReadRefreshClock: { nowMs: Schema.Number },
	ChangedRange: { range: Schema.String },
	ClickedWidenRange: {},
	CompletedSaveLayout: {},
	CompletedSaveViewPrefs: {},
	GotMapMessage: { message: ServiceMap.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
