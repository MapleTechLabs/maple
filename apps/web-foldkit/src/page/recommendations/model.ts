import { V2AttributeMapping, V2Recommendation } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "../../data/keyed"
import { LoadFailure } from "../../data/load-failure"
import * as CopyButton from "../../ui/copy-button"

// `/recommendations/$recommendationKey` (apps/web/src/routes/recommendations/$recommendationKey.tsx).

/** `BusyAction`: the one write in flight. */
export const BusyAction = Schema.NullOr(Schema.Literals(["apply", "dismiss", "reopen"]))
export type BusyAction = typeof BusyAction.Type

export const Model = Schema.Struct({
	recommendationKey: Schema.String,
	/** `Date.now()` at render, read once on entry for the rail's relative time. */
	nowMs: Schema.NullOr(Schema.Number),
	/** `recommendationIssuesListAtom`: every page of the org's recommendations. */
	list: KeyedSchema(Schema.Array(V2Recommendation), LoadFailure),
	/** `ingestAttributeMappingsListAtom`: mounted by `useAtomRefresh`, so legacy reads it too. */
	mappings: KeyedSchema(Schema.Array(V2AttributeMapping), LoadFailure),
	busy: BusyAction,
	copy: CopyButton.Model,
})
export type Model = typeof Model.Type
