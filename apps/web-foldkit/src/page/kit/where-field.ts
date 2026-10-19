import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure } from "../../data/load-failure"
import { CaretMessage, WhereCaret } from "./where-autocomplete"

// Any number of where editors with suggestions (`WhereClauseEditor`), by field id: their carets,
// open lists and active keys' values. The expressions stay with the owner.

export const WhereFieldMessage = defineMessageUnion({
	GotCaret: { fieldId: Schema.String, message: CaretMessage },
	MovedSuggestion: { fieldId: Schema.String, step: Schema.Number },
	DismissedSuggestions: { fieldId: Schema.String },
	AppliedSuggestion: { fieldId: Schema.String, index: Schema.Number },
	PressedTab: { fieldId: Schema.String },
	/** Enter never inserts a newline: it applies an open list's active row. */
	PressedEnter: { fieldId: Schema.String },
	CompletedPlaceCaret: {},
	CompletedFetchValues: {
		slot: Schema.String,
		key: Schema.String,
		result: Schema.Result(Schema.Array(Schema.String), LoadFailure),
	},
})
export type WhereFieldMessage = typeof WhereFieldMessage.Type

export const WhereFields = Schema.Struct({
	carets: Schema.Record(Schema.String, WhereCaret),
	/** The active key's values per field (`<field id>:attr` / `:resource`). */
	values: Schema.Record(Schema.String, KeyedSchema(Schema.Array(Schema.String), LoadFailure)),
})
export type WhereFields = typeof WhereFields.Type

export const initWhereFields = (): WhereFields => ({ carets: {}, values: {} })
