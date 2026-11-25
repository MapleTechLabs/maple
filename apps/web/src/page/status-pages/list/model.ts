import * as Policy from "@maple/domain/policy"
import { StatusPageId } from "@maple/domain"
import { Schema } from "effect"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { StatusPageSummary } from "../shared/derive"

// `/status-pages`: the org's pages with their state.

export const Model = Schema.Struct({
	/** `statusPages.list` with each page's components and open incidents. */
	pages: KeyedSchema(Schema.Array(StatusPageSummary), LoadFailure),
	nowMs: Schema.NullOr(Schema.Number),
	/** `statusPageOrgKey` of the org, none until computed: the address is `/s/<org key>/<slug>`. */
	orgKey: Schema.Option(Schema.String),
	grants: Schema.Array(Policy.PermissionName),
	/** Each row's "..." menu, by page id, created on first use. */
	rowMenus: Schema.Record(Schema.String, Menu.Model),
	/** The page the delete dialog asks about. */
	deletingPageId: Schema.NullOr(StatusPageId),
	deleteDialog: Dialog.Model,
	isDeleting: Schema.Boolean,
})
export type Model = typeof Model.Type

/** The viewer may change what this page edits (`status_pages:edit`). */
export const canManage = (model: Pick<Model, "grants">): boolean =>
	Policy.can(model.grants, "status_pages:edit")
