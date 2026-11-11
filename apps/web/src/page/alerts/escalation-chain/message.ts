import { V2EscalationChain, V2OnCallSchedule } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema, AlertRuleRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"
import { OrgMember } from "../shared/org-members"

const rows = <S extends Schema.Top>(row: S) => ({ orgId: Schema.String, rows: Schema.Array(row) })

export const MenuKind = Schema.Literals(["targets", "actions"])
export type MenuKind = typeof MenuKind.Type

export const Message = defineMessageUnion({
	CompletedFetchExisting: { key: Schema.String, result: LoadOutcome(V2EscalationChain) },
	ClickedRetryExisting: {},
	UpdatedDestinations: rows(AlertDestinationRowSchema),
	UpdatedRules: rows(AlertRuleRowSchema),
	CompletedFetchMembers: { result: Schema.Result(Schema.Array(OrgMember), Schema.String) },
	CompletedFetchSchedules: { result: LoadOutcome(Schema.Array(V2OnCallSchedule)) },
	CompletedFetchSession: SessionGrants,
	ChangedName: { value: Schema.String },
	ChangedDescription: { value: Schema.String },
	ChangedRepeatCount: { value: Schema.String },
	ChangedWait: { key: Schema.String, value: Schema.String },
	/** The "+" between two cards: a new step at `index`. */
	ClickedInsertStep: { index: Schema.Number },
	/** A step's target picker or its actions menu. */
	GotMenuMessage: { kind: MenuKind, key: Schema.String, message: Menu.Message },
	ClickedRemoveTarget: { key: Schema.String, target: Schema.String },
	ClickedSave: {},
	CompletedSave: { result: LoadOutcome(V2EscalationChain) },
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedDelete: {},
	ClickedConfirmDelete: {},
	CompletedDelete: { result: LoadOutcome(Schema.Void) },
	ClickedCancel: {},
	GotLeaveDialogMessage: { message: Dialog.Message },
	ClickedDiscard: {},
	FailedLoadProviderLogo: { type: Schema.String },
	CompletedFocus: {},
})
export type Message = typeof Message.Type
