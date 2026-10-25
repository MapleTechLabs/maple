import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../../../data/load-failure"
import * as Tabs from "../../../../ui/tabs"
import * as InfraCorrelation from "../../../kit/infra-correlation"
import { LogEntry, SpanDetail } from "./model"

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const AttributeScope = Schema.Literals(["span", "resource"])
export type AttributeScope = typeof AttributeScope.Type

export const Message = defineMessageUnion({
	CompletedFetchDetail: result(SpanDetail),
	CompletedFetchLogs: result(Schema.Array(LogEntry)),
	ClickedClose: {},
	ClickedParentSpan: { spanId: Schema.String },
	ClickedCopy: { id: Schema.String, text: Schema.String },
	SucceededCopy: { id: Schema.String, generation: Schema.Number },
	FailedCopy: { id: Schema.String, generation: Schema.Number },
	ElapsedCopyStatus: { id: Schema.String, generation: Schema.Number },
	ToggledCollapsible: { id: Schema.String },
	ToggledErrorExpanded: {},
	ClickedAttributeFilter: {
		scope: AttributeScope,
		key: Schema.String,
		value: Schema.String,
		isExclude: Schema.Boolean,
	},
	GotTabsMessage: { message: Tabs.Message },
	GotInfraMessage: { message: InfraCorrelation.Message },
})
export type Message = typeof Message.Type

/** What the panel asks of the page: close it, select another span, or open the filtered list. */
export const OutMessage = defineMessageUnion({
	Closed: {},
	SelectedSpanId: { spanId: Schema.String },
	RequestedNavigation: { url: Schema.String },
})
export type OutMessage = typeof OutMessage.Type
