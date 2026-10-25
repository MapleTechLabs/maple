import { V2SourceUsageSummary } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as ToggleGroup from "../../../ui/toggle-group"
import { SourceList } from "../kit/data"

// `/sources`.

export const Model = Schema.Struct({
	/** `Date.now()` at render, read once on entry for the rows' relative times. */
	nowMs: Schema.NullOr(Schema.Number),
	/** `sourcesListAtom`. */
	list: KeyedSchema(SourceList, LoadFailure),
	/** Every source's volume over the last 24 hours; the list shows without it. */
	usage: KeyedSchema(V2SourceUsageSummary, LoadFailure),
	/** All, OpenTelemetry (push) or Integrations: one value, "all" when the active chip is unpressed. */
	kindFilter: ToggleGroup.Model,
	/** "Needs attention": pressed narrows to disconnected, failing and stale sources. */
	attentionFilter: ToggleGroup.Model,
})

export const SOURCE_KINDS = ["all", "push", "integration"] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]
export type Model = typeof Model.Type
