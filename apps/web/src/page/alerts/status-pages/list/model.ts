import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import { StatusPageSummary } from "../../shared/status-page-derive"

// The hub's Status pages tab: the pages with their state, and the create dialog.

export const Model = Schema.Struct({
	/** `statusPages.list` with each page's components and open incidents, read while the tab is open. */
	pages: KeyedSchema(Schema.Array(StatusPageSummary), LoadFailure),
	createDialog: Dialog.Model,
	name: Schema.String,
	slug: Schema.String,
	/** The user typed an address; until then it follows the name. */
	isSlugEdited: Schema.Boolean,
	isCreating: Schema.Boolean,
	createFailure: Schema.NullOr(LoadFailure),
})
export type Model = typeof Model.Type
