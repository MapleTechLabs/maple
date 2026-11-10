import * as Policy from "@maple/domain/policy"
import { EscalationChainId } from "@maple/domain/http"
import { V2EscalationChain, V2OnCallSchedule } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema, AlertRuleRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { OrgMember } from "../shared/org-members"
import { Form } from "./form"

// `/alerts/escalation-chains/new` and `/alerts/escalation-chains/:chainId`: the chain editor.

export const Model = Schema.Struct({
	/** The chain being edited; `null` creates. */
	editingId: Schema.NullOr(EscalationChainId),
	/** The URL named a chain id that does not decode. */
	isBadId: Schema.Boolean,
	/** The edited chain's read; the form fills from it once. */
	existing: KeyedSchema(V2EscalationChain, LoadFailure),
	form: Form,
	/** The form as it was opened or last saved: `form` differing from it is an unsaved edit. */
	baseline: Form,
	destinations: Schema.NullOr(Schema.Array(AlertDestinationRowSchema)),
	rules: Schema.NullOr(Schema.Array(AlertRuleRowSchema)),
	/** `null` until the members load, and after a failed read (`isMembersFailed`). */
	members: Schema.NullOr(Schema.Array(OrgMember)),
	isMembersFailed: Schema.Boolean,
	/** `null` until the schedules load, and after a failed read (`isSchedulesFailed`). */
	schedules: Schema.NullOr(Schema.Array(V2OnCallSchedule)),
	isSchedulesFailed: Schema.Boolean,
	/** Destination types whose brand image failed to load: they draw the monogram. */
	brokenLogos: Schema.Array(Schema.String),
	/** Each step's target picker and actions menu, by menu id. */
	menus: Schema.Record(Schema.String, Menu.Model),
	isSaving: Schema.Boolean,
	/** A save was tried: each field shows what is wrong with it. */
	isShowingErrors: Schema.Boolean,
	saveFailure: Schema.NullOr(LoadFailure),
	deleteDialog: Dialog.Model,
	isDeleting: Schema.Boolean,
	deleteError: Schema.NullOr(Schema.String),
	/** "Unsaved changes": a navigation held while the form has edits, and where it was going. */
	leaveDialog: Dialog.Model,
	pendingLeaveUrl: Schema.NullOr(Schema.String),
	grants: Schema.Array(Policy.PermissionName),
	isSessionLoaded: Schema.Boolean,
})
export type Model = typeof Model.Type

/** The viewer may change chains (`alerts:manage`); the API refuses anyone else. */
export const canManage = (model: Pick<Model, "grants">): boolean => Policy.has(model.grants, "alerts:manage")
