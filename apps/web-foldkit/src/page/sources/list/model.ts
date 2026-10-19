import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { SourceList } from "../kit/data"

// `/sources` (apps/web/src/routes/sources/index.tsx, components/sources/sources-table.tsx).

export const Model = Schema.Struct({
	/** `Date.now()` at render, read once on entry for the rows' relative times. */
	nowMs: Schema.NullOr(Schema.Number),
	/** `sourcesListAtom`. */
	list: KeyedSchema(SourceList, LoadFailure),
})
export type Model = typeof Model.Type
