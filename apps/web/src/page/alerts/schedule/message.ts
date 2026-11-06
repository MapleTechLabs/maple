import * as Policy from "@maple/domain/policy"
import { OnCallOverrideId } from "@maple/domain/http"
import { V2OnCallOverride, V2OnCallSchedule, V2OnCallShifts } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { OrgMember } from "../shared/org-members"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSchedule: { key: Schema.String, result: outcome(V2OnCallSchedule) },
	CompletedFetchShifts: { key: Schema.String, result: outcome(V2OnCallShifts) },
	CompletedFetchOverrides: { key: Schema.String, result: outcome(Schema.Array(V2OnCallOverride)) },
	CompletedFetchMembers: { result: Schema.Result(Schema.Array(OrgMember), Schema.String) },
	CompletedFetchSession: { orgId: Schema.String, grants: Schema.Array(Policy.PermissionName) },
	ClickedRetry: {},
	ClickedPreviousWeek: {},
	ClickedNextWeek: {},
	ClickedThisWeek: {},
	/** A final shift's bar: an override for its range, its person preselected. */
	ClickedShift: { startMs: Schema.Number, endMs: Schema.Number },
	ClickedNewOverride: {},
	GotOverrideDialogMessage: { message: Dialog.Message },
	ChangedOverrideUser: { value: Schema.String },
	ChangedOverrideStart: { value: Schema.String },
	ChangedOverrideEnd: { value: Schema.String },
	ClickedCreateOverride: {},
	CompletedCreateOverride: { openCount: Schema.Number, result: outcome(V2OnCallOverride) },
	ClickedDeleteOverride: { overrideId: OnCallOverrideId },
	CompletedDeleteOverride: { overrideId: OnCallOverrideId, result: outcome(Schema.Void) },
})
export type Message = typeof Message.Type
