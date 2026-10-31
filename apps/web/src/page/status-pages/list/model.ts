import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { StatusPageSummary } from "../shared/derive"

// `/status-pages`: the org's pages with their state.

export const Model = Schema.Struct({
	/** `statusPages.list` with each page's components and open incidents. */
	pages: KeyedSchema(Schema.Array(StatusPageSummary), LoadFailure),
	nowMs: Schema.NullOr(Schema.Number),
	isAdmin: Schema.Boolean,
})
export type Model = typeof Model.Type
