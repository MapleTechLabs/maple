import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import { AutocompleteLookup, LookupNames } from "../../kit/autocomplete-lookups"

// The advanced filter dialog's state (`AdvancedFilterDialog` + `WhereClauseEditor` +
// `useWhereClauseAutocomplete`), kept apart from the list Model it sits in.

/** The lookups `AutocompleteValuesProvider` fires on first focus (the traces facets are the list's). */
export const ADVANCED_LOOKUPS: ReadonlyArray<AutocompleteLookup> = [
	"logsFacets",
	"spanAttributeKeys",
	"resourceAttributeKeys",
	"metricAttributeKeys",
	"productEventNames",
	"productEventAttributeKeys",
]

export const AdvancedFilter = Schema.Struct({
	dialog: Dialog.Model,
	draft: Schema.String,
	/** The textarea's caret, which picks the clause context the suggestions complete. */
	cursor: Schema.Number,
	isFocused: Schema.Boolean,
	/** Escape hid the suggestions until the next edit or caret move. */
	isDismissed: Schema.Boolean,
	activeIndex: Schema.Number,
	lookups: Schema.Record(Schema.String, KeyedSchema(LookupNames, LoadFailure)),
})
export type AdvancedFilter = typeof AdvancedFilter.Type

export const initAdvanced = (): AdvancedFilter => ({
	dialog: Dialog.init("traces-advanced-filter", "dialog"),
	draft: "",
	cursor: 0,
	isFocused: false,
	isDismissed: false,
	activeIndex: 0,
	lookups: {},
})
