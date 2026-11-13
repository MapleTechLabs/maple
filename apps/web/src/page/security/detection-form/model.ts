import {
	AlertDestinationId,
	AlertRuleId,
	AlertSeverity,
	AuditDetection,
	AuditDetectionListResponse,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { AlertDestinationRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Menu from "@maple/views/ui/menu"
import { SecurityDetectionNewSearch } from "../../../route/search"
import { LiveRows, LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"
import { Form, SelectField, TextField } from "./form"

// `/security/detections/new`: the editor of one audit log detection, new or (`?detectionId=`)
// existing. Only org admins (`audit_log:read`) open it.

export const Model = Schema.Struct({
	search: SecurityDetectionNewSearch,
	/** The detection being edited; `null` creates. */
	editingId: Schema.NullOr(AlertRuleId),
	/** The URL names a detection that is not an id, or that the org does not have. */
	isMissing: Schema.Boolean,
	/** The org's detections, read to find the edited one; the form fills from it once. */
	existing: KeyedSchema(AuditDetectionListResponse, LoadFailure),
	form: Form,
	/** The ready-made detection last picked in "Start from"; `""` is none. */
	templateId: Schema.String,
	isSaving: Schema.Boolean,
	/** The last save's failure, shown above the action bar in the server's words. */
	saveFailure: Schema.NullOr(LoadFailure),
	destinations: LiveRows(AlertDestinationRowSchema),
	destinationMenu: Menu.Model,
	grants: Schema.Array(Policy.PermissionName),
	/** False until the session answers: the page says nothing about access before it knows. */
	isGrantsRead: Schema.Boolean,
})
export type Model = typeof Model.Type

export { auditAccessOf as accessOf } from "../kit/audit-access"

export const Message = defineMessageUnion({
	CompletedReadGrants: SessionGrants,
	CompletedFetchExisting: { key: Schema.String, result: LoadOutcome(AuditDetectionListResponse) },
	ClickedRetry: {},
	UpdatedDestinations: { orgId: Schema.String, rows: Schema.Array(AlertDestinationRowSchema) },
	PickedTemplate: { id: Schema.String },
	ChangedText: { field: TextField, value: Schema.String },
	ChangedSelect: { field: SelectField, value: Schema.String },
	PickedSeverity: { severity: AlertSeverity },
	ToggledEnabled: {},
	RemovedDestination: { id: AlertDestinationId },
	GotDestinationMenuMessage: { message: Menu.Message },
	ClickedSave: {},
	CompletedSave: { result: LoadOutcome(AuditDetection) },
})
export type Message = typeof Message.Type
