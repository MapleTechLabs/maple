import { V2IngestRule } from "@maple/domain/http/v2"
import {
	IngestRuleDetector,
	IngestRuleField,
	IngestRuleOp,
	IngestRuleRedactMethod,
	IngestRuleScope,
	IngestRuleSignal,
} from "@maple/domain/ingest-rules"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../data/load-failure"
import * as Combobox from "../../../ui/combobox"
import { ActionType, TextPart } from "./form"
import { PreviewSignal, Samples } from "./preview"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const KeyScope = Schema.Literals(["span", "log", "resource"])
export type KeyScope = typeof KeyScope.Type

export const Message = defineMessageUnion({
	CompletedFetchExisting: { result: outcome(V2IngestRule) },
	CompletedFetchSession: { orgId: Schema.String, isAdmin: Schema.Boolean },
	CompletedFetchKeys: { scope: KeyScope, keys: Schema.Array(Schema.String) },
	CompletedFetchServices: { services: Schema.Array(Schema.String) },
	CompletedFetchSamples: { key: Schema.String, result: outcome(Samples) },
	ChangedText: { part: TextPart, value: Schema.String },
	ToggledEnabled: {},
	ToggledSignal: { signal: IngestRuleSignal },
	PickedAction: { actionType: ActionType },
	AddedCondition: {},
	RemovedCondition: { id: Schema.Number },
	ChangedConditionField: { id: Schema.Number, field: IngestRuleField },
	ChangedConditionOp: { id: Schema.Number, op: IngestRuleOp },
	ChangedConditionValue: { id: Schema.Number, value: Schema.String },
	ChangedConditionValues: { id: Schema.Number, values: Schema.String },
	ToggledConditionValue: { id: Schema.Number, value: Schema.String },
	GotKeyMessage: { id: Schema.Number, message: Combobox.Message },
	ToggledDetector: { detector: IngestRuleDetector },
	ToggledScope: { scope: IngestRuleScope },
	PickedMethod: { method: IngestRuleRedactMethod },
	PickedPreviewSignal: { signal: PreviewSignal },
	PickedPreviewService: { service: Schema.String },
	ClickedRetryPreview: {},
	ClickedSave: {},
	CompletedSave: { result: outcome(V2IngestRule) },
})
export type Message = typeof Message.Type
