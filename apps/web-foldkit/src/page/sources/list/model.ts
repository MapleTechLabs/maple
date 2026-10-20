import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { SourceList } from "../kit/data"

// `/sources`.

export const Model = Schema.Struct({
	/** `Date.now()` at render, read once on entry for the rows' relative times. */
	nowMs: Schema.NullOr(Schema.Number),
	/** `sourcesListAtom`. */
	list: KeyedSchema(SourceList, LoadFailure),
})
export type Model = typeof Model.Type
