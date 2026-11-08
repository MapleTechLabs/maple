import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { StatusPageSummary } from "../shared/derive"

// `/status-pages`: the org's pages with their state.

export const Model = Schema.Struct({
	/** `statusPages.list` with each page's components and open incidents. */
	pages: KeyedSchema(Schema.Array(StatusPageSummary), LoadFailure),
	nowMs: Schema.NullOr(Schema.Number),
	grants: Schema.Array(Policy.PermissionName),
})
export type Model = typeof Model.Type

/** The viewer may change what this page edits (`status_pages:edit`). */
export const canManage = (model: Pick<Model, "grants">): boolean =>
	Policy.has(model.grants, "status_pages:edit")
