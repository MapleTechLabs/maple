import { V2SourceUsageSummary } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { SourceId } from "@maple/primitives"
import { SourceList } from "../kit/data"

// `/sources`.

export const Model = Schema.Struct({
	/** `Date.now()` at render, read once on entry for the rows' relative times. */
	nowMs: Schema.NullOr(Schema.Number),
	/** The session's permissions: anyone reads sources, `sources:manage` adds and changes them. */
	grants: Schema.Array(Policy.PermissionName),
	list: KeyedSchema(SourceList, LoadFailure),
	/** Every source's volume over the last 24 hours; the list shows without it. */
	usage: KeyedSchema(V2SourceUsageSummary, LoadFailure),
	/** Narrows every group to the sources whose name or platform matches. */
	search: Schema.String,
	/** The paused source a row's Resume is in flight for. */
	resuming: Schema.NullOr(SourceId),
})

export type Model = typeof Model.Type

export const canManage = (model: Pick<Model, "grants">): boolean => Policy.has(model.grants, "sources:manage")
