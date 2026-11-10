import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { LookupNames } from "../../kit/autocomplete-lookups"
import { WhereFields } from "../../kit/where-field"

// The advanced filter dialog's state, kept apart from the list Model it sits in.

/** The one where field the dialog holds, and its textarea. */
export const ADVANCED_FIELD_ID = "logs-advanced"
export const ADVANCED_TEXTAREA_ID = "logs-advanced-where"

export const AdvancedFilter = Schema.Struct({
	dialog: Dialog.Model,
	draft: Schema.String,
	fields: WhereFields,
	/** The `resource.*` keys it suggests, read once per window on open (log keys are the list's). */
	resourceKeys: KeyedSchema(LookupNames, LoadFailure),
})
export type AdvancedFilter = typeof AdvancedFilter.Type
