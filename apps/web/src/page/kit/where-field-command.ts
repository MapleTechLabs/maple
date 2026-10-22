import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import { getMetricAttributeValues } from "@maple/web-data/warehouse/metrics"
import { getResourceAttributeValues, getSpanAttributeValues } from "@maple/web-data/warehouse/traces"
import { Effect, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { caretEvents, listboxEvents, placeCaret } from "./where-autocomplete"
import { WhereFieldMessage } from "./where-field"

// The where fields' Commands and Mounts: the active key's values, and each textarea's caret.

const valuesOf = (response: { readonly data: ReadonlyArray<{ readonly attributeValue: string }> }) =>
	response.data.map((row) => row.attributeValue)

/** One active key's values: span or resource attributes over the provider's window, or a metric's. */
export const WhereValuesRequest = Schema.Union([
	Schema.TaggedStruct("Span", {
		startTime: Schema.String,
		endTime: Schema.String,
		attributeKey: Schema.String,
	}),
	Schema.TaggedStruct("Resource", {
		startTime: Schema.String,
		endTime: Schema.String,
		attributeKey: Schema.String,
	}),
	Schema.TaggedStruct("Metric", {
		attributeKey: Schema.String,
		metricName: Schema.String,
		metricType: Schema.Literals(QUERY_BUILDER_METRIC_TYPES),
	}),
])
export type WhereValuesRequest = typeof WhereValuesRequest.Type

/** `getSpanAttributeValuesResultAtom` and friends, for the key the caret is in. */
export const lookupWhereValues = (request: WhereValuesRequest) => {
	switch (request._tag) {
		case "Span":
			return Effect.map(getSpanAttributeValues({ data: { ...request } }), valuesOf)
		case "Resource":
			return Effect.map(getResourceAttributeValues({ data: { ...request } }), valuesOf)
		case "Metric":
			return Effect.map(getMetricAttributeValues({ data: { ...request } }), valuesOf)
	}
}

export const FetchWhereFieldValues = Command.define("FetchWhereFieldValues", {
	args: { slot: Schema.String, key: Schema.String, request: WhereValuesRequest },
	messages: [WhereFieldMessage.CompletedFetchValues],
	execute: ({ slot, key, request }) =>
		lookupWhereValues(request).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => WhereFieldMessage.CompletedFetchValues({ slot, key, result })),
		),
})

/** A field's caret, focus and blur, read off its textarea's native events. */
export const MountWhereFieldCaret = Mount.defineStream("MountWhereFieldCaret", {
	args: { fieldId: Schema.String },
	messages: [WhereFieldMessage.GotCaret],
	execute: ({ element, fieldId }) =>
		Stream.map(caretEvents(element), (message) => WhereFieldMessage.GotCaret({ fieldId, message })),
})

/** The open list: the textarea keeps focus while a row is pressed, and the list follows it. */
export const MountWhereFieldListbox = Mount.defineStream("MountWhereFieldListbox", {
	args: { fieldId: Schema.String, textareaId: Schema.String },
	messages: [WhereFieldMessage.GotCaret],
	execute: ({ element, fieldId, textareaId }) =>
		Stream.map(listboxEvents(element, textareaId), (message) =>
			WhereFieldMessage.GotCaret({ fieldId, message }),
		),
})

export const PlaceWhereFieldCaret = Command.define("PlaceWhereFieldCaret", {
	args: { id: Schema.String, value: Schema.String, cursor: Schema.Number },
	messages: [WhereFieldMessage.CompletedPlaceCaret],
	execute: ({ id, value, cursor }) =>
		Effect.as(placeCaret(id, value, cursor), WhereFieldMessage.CompletedPlaceCaret()),
})
