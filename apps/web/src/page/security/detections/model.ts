import {
	AlertRuleId,
	AuditDetection,
	AuditDetectionDeleteResponse,
	AuditDetectionListResponse,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

// `/security/detections`: the org's audit log detections, each an alert rule that counts audit
// events. Only org admins (`audit_log:read`) read or change them.

export const Model = Schema.Struct({
	grants: Schema.Array(Policy.PermissionName),
	/** False until the session answers: the page says nothing about access before it knows. */
	isGrantsRead: Schema.Boolean,
	/** The list as the API last gave it; a saved toggle or a delete writes the API's answer into it. */
	list: KeyedSchema(AuditDetectionListResponse, LoadFailure),
	/** The detections whose switch has a save in flight. */
	togglingIds: Schema.Array(AlertRuleId),
	/** The detection the delete dialog asks about. */
	confirmDeleteId: Schema.NullOr(AlertRuleId),
	deletingId: Schema.NullOr(AlertRuleId),
	deleteDialog: Dialog.Model,
})
export type Model = typeof Model.Type

export { auditAccessOf as accessOf } from "../kit/audit-access"

export const Message = defineMessageUnion({
	CompletedReadGrants: SessionGrants,
	CompletedFetchDetections: { key: Schema.String, result: LoadOutcome(AuditDetectionListResponse) },
	ClickedRetry: {},
	ClickedEdit: { id: AlertRuleId },
	ToggledDetection: { id: AlertRuleId },
	CompletedToggle: { id: AlertRuleId, result: LoadOutcome(AuditDetection) },
	ClickedDelete: { id: AlertRuleId },
	GotDeleteDialogMessage: { message: Dialog.Message },
	ClickedConfirmDelete: {},
	CompletedDelete: { id: AlertRuleId, result: LoadOutcome(AuditDetectionDeleteResponse) },
})
export type Message = typeof Message.Type
