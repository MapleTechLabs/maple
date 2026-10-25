import { V2SetupAudit } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"

// `SetupAuditSection`: the audit report.

export const AuditData = AsyncData.Schema(V2SetupAudit, LoadFailure)

export const Model = Schema.Struct({
	audit: AuditData.schema,
	isPassingOpen: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CompletedFetchAudit: { result: Schema.Result(V2SetupAudit, LoadFailure) },
	ClickedRerun: {},
	ClickedRetry: {},
	ToggledPassing: {},
})
export type Message = typeof Message.Type
