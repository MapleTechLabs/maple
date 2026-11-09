import * as Policy from "@maple/domain/policy"
import { EscalationChainId } from "@maple/domain/http"
import { V2EscalationChain, V2OnCallSchedule } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema, AlertRuleRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { AlertsEscalationChainSearch } from "../../../route/search"
import { OrgMember } from "../shared/org-members"
import { Form } from "./form"

// `/alerts/escalation-chains/new` and `/alerts/escalation-chains/:chainId`: the chain editor.

export const Model = Schema.Struct({
	search: AlertsEscalationChainSearch,
	/** The chain being edited; `null` creates. */
	editingId: Schema.NullOr(EscalationChainId),
	/** The URL named a chain id that does not decode. */
	isBadId: Schema.Boolean,
	/** The edited chain's read; the form fills from it once. */
	existing: KeyedSchema(V2EscalationChain, LoadFailure),
	form: Form,
	destinations: Schema.NullOr(Schema.Array(AlertDestinationRowSchema)),
	rules: Schema.NullOr(Schema.Array(AlertRuleRowSchema)),
	members: Schema.NullOr(Schema.Array(OrgMember)),
	schedules: Schema.NullOr(Schema.Array(V2OnCallSchedule)),
	/** Each step's target picker and actions menu, by menu id. */
	menus: Schema.Record(Schema.String, Menu.Model),
	isSaving: Schema.Boolean,
	/** A save was tried: each field shows what is wrong with it. */
	isShowingErrors: Schema.Boolean,
	saveFailure: Schema.NullOr(LoadFailure),
	deleteDialog: Dialog.Model,
	isDeleting: Schema.Boolean,
	deleteError: Schema.NullOr(Schema.String),
	grants: Schema.Array(Policy.PermissionName),
	isSessionLoaded: Schema.Boolean,
})
export type Model = typeof Model.Type

/** The viewer may change chains (`alerts:manage`); the API refuses anyone else. */
export const canManage = (model: Pick<Model, "grants">): boolean => Policy.has(model.grants, "alerts:manage")
