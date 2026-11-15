import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/load-failure"
import * as Tabs from "../../ui/tabs"
import * as ProfileFlamegraph from "../../profiles/profile-flamegraph"
import {
	LogEntry,
	SpanDetail,
	SpanDetailRequest,
	SpanLogsRequest,
	SpanProfile,
	SpanProfileRequest,
} from "../trace-source"

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

const Attributes = Schema.Record(Schema.String, Schema.String)

/** A detail read: the trace's trimmed maps stand in when the source has no row for the span. */
export const DetailFetch = Schema.Struct({
	key: Schema.String,
	request: SpanDetailRequest,
	fallback: Schema.Struct({ spanAttributes: Attributes, resourceAttributes: Attributes }),
})
export type DetailFetch = typeof DetailFetch.Type

export const LogsFetch = Schema.Struct({ key: Schema.String, request: SpanLogsRequest })
export type LogsFetch = typeof LogsFetch.Type

export const ProfileFetch = Schema.Struct({ key: Schema.String, request: SpanProfileRequest })
export type ProfileFetch = typeof ProfileFetch.Type

export const AttributeScope = Schema.Literals(["span", "resource"])
export type AttributeScope = typeof AttributeScope.Type

export const Message = defineMessageUnion({
	CompletedFetchDetail: result(SpanDetail),
	CompletedFetchLogs: result(Schema.Array(LogEntry)),
	CompletedFetchProfile: result(Schema.NullOr(SpanProfile)),
	GotFlamegraphMessage: { message: ProfileFlamegraph.Message },
	/** The source's cache answered first; `fetch` revalidates it unless fresh. */
	FoundCachedDetail: { fetch: DetailFetch, detail: SpanDetail, isFresh: Schema.Boolean },
	FoundCachedLogs: { fetch: LogsFetch, logs: Schema.Array(LogEntry), isFresh: Schema.Boolean },
	ClickedClose: {},
	ClickedParentSpan: { spanId: Schema.String },
	ClickedLog: { key: Schema.String },
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
	/** `shown` is the tabs on screen when the message was made: its indexes count against those. */
	GotTabsMessage: { message: Tabs.Message, shown: Schema.Array(Schema.String) },
})
export type Message = typeof Message.Type

/** What the panel asks of the page: close it, select another span, open a log, or filter the list. */
export const OutMessage = defineMessageUnion({
	Closed: {},
	SelectedSpanId: { spanId: Schema.String },
	SelectedLog: { key: Schema.String },
	RequestedAttributeFilter: {
		scope: AttributeScope,
		key: Schema.String,
		value: Schema.String,
		isExclude: Schema.Boolean,
	},
})
export type OutMessage = typeof OutMessage.Type
