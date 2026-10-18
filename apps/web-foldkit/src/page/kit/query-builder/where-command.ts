import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import { getMetricAttributeValues } from "@maple/web-data/warehouse/metrics"
import { getResourceAttributeValues, getSpanAttributeValues } from "@maple/web-data/warehouse/traces"
import { Effect, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { caretEvents, listboxEvents, placeCaret } from "../where-autocomplete"
import { Message } from "./panel-message"

// The where editors' Commands and Mounts: the active key's values, and the textarea's caret.

const valuesOf = (response: { readonly data: ReadonlyArray<{ readonly attributeValue: string }> }) =>
	response.data.map((row) => row.attributeValue)

/** One active key's values: span or resource attributes over the provider's window, or a metric's. */
export const WhereValuesRequest = Schema.Union([
	Schema.TaggedStruct("Span", { startTime: Schema.String, endTime: Schema.String, attributeKey: Schema.String }),
	Schema.TaggedStruct("Resource", { startTime: Schema.String, endTime: Schema.String, attributeKey: Schema.String }),
	Schema.TaggedStruct("Metric", {
		attributeKey: Schema.String,
		metricName: Schema.String,
		metricType: Schema.Literals(QUERY_BUILDER_METRIC_TYPES),
	}),
])
export type WhereValuesRequest = typeof WhereValuesRequest.Type

const lookup = (request: WhereValuesRequest) => {
	switch (request._tag) {
		case "Span":
			return Effect.map(getSpanAttributeValues({ data: { ...request } }), valuesOf)
		case "Resource":
			return Effect.map(getResourceAttributeValues({ data: { ...request } }), valuesOf)
		case "Metric":
			return Effect.map(getMetricAttributeValues({ data: { ...request } }), valuesOf)
	}
}

/** `getSpanAttributeValuesResultAtom` and friends, for the key the caret is in. */
export const FetchWhereValues = Command.define("FetchQueryPanelWhereValues", {
	args: { slot: Schema.String, key: Schema.String, request: WhereValuesRequest },
	messages: [Message.CompletedFetchWhereValues],
	execute: ({ slot, key, request }) =>
		lookup(request).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchWhereValues({ slot, key, result })),
		),
})

/** The where textarea's caret, focus and blur, read off the native events. */
export const MountWhereCaret = Mount.defineStream("MountQueryPanelWhereCaret", {
	args: { queryId: Schema.String },
	messages: [Message.GotWhereCaret],
	execute: ({ element, queryId }) =>
		Stream.map(caretEvents(element), (message) => Message.GotWhereCaret({ queryId, message })),
})

export const whereTextareaId = (queryId: string): string => `where-${queryId}`

/** The open list: the textarea keeps focus while a row is pressed, and the list follows it. */
export const MountWhereListbox = Mount.defineStream("MountQueryPanelWhereListbox", {
	args: { queryId: Schema.String },
	messages: [Message.GotWhereCaret],
	execute: ({ element, queryId }) =>
		Stream.map(listboxEvents(element, whereTextareaId(queryId)), (message) =>
			Message.GotWhereCaret({ queryId, message }),
		),
})

export const PlaceWhereCaret = Command.define("PlaceQueryPanelWhereCaret", {
	args: { id: Schema.String, value: Schema.String, cursor: Schema.Number },
	messages: [Message.CompletedPlaceWhereCaret],
	execute: ({ id, value, cursor }) => Effect.as(placeCaret(id, value, cursor), Message.CompletedPlaceWhereCaret()),
})
