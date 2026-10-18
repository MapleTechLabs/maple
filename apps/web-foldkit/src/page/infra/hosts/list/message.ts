import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import { HostRows } from "./model"

export const HostScope = Schema.Literals(["saturated", "elevated", "stale"])
export type HostScope = typeof HostScope.Type

export const HostSortKey = Schema.Literals(["hostName", "load15", "lastSeen"])
export type HostSortKey = typeof HostSortKey.Type

export const Message = defineMessageUnion({
	CompletedFetchHosts: { key: Schema.String, result: Schema.Result(HostRows, LoadFailure) },
	ChangedQuery: { value: Schema.String },
	ChangedScope: { scope: Schema.optional(HostScope) },
	ClickedClearSearch: {},
	ClickedSort: { key: HostSortKey },
	GotFrameMessage: { message: Frame.Message },
	GotInstallMessage: { message: InstallModal.Message },
})
export type Message = typeof Message.Type
