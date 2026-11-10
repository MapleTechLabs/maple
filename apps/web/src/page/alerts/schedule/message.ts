import { OnCallOverrideId } from "@maple/domain/http"
import { V2OnCallOverride, V2OnCallSchedule, V2OnCallShifts } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "@maple/views/ui/dialog"
import { RangeDays } from "../shared/coverage-preview"
import { OrgMember } from "../shared/org-members"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSchedule: {
		key: Schema.String,
		readAtMs: Schema.Number,
		result: LoadOutcome(V2OnCallSchedule),
	},
	CompletedFetchShifts: { key: Schema.String, result: LoadOutcome(V2OnCallShifts) },
	CompletedFetchOverrides: { key: Schema.String, result: LoadOutcome(Schema.Array(V2OnCallOverride)) },
	CompletedFetchMembers: { result: Schema.Result(Schema.Array(OrgMember), Schema.String) },
	CompletedFetchSession: SessionGrants,
	ClickedRetry: {},
	ClickedRetryShifts: {},
	ClickedRetryOverrides: {},
	ClickedPreviousWeek: {},
	ClickedNextWeek: {},
	ClickedThisWeek: {},
	PickedRange: { days: RangeDays },
	/** A gap in the summary: its bar on the calendar takes focus. */
	ClickedGap: { index: Schema.Number },
	CompletedFocusGap: {},
	/** A final shift's bar: an override over its whole range, for someone else to cover. */
	ClickedShift: { startMs: Schema.Number, endMs: Schema.Number },
	ClickedNewOverride: {},
	GotOverrideDialogMessage: { message: Dialog.Message },
	ChangedOverrideUser: { value: Schema.String },
	ChangedOverrideStart: { value: Schema.String },
	ChangedOverrideEnd: { value: Schema.String },
	ClickedCreateOverride: {},
	CompletedCreateOverride: { openCount: Schema.Number, result: LoadOutcome(V2OnCallOverride) },
	ClickedDeleteOverride: { overrideId: OnCallOverrideId },
	ClickedConfirmDeleteOverride: {},
	GotDeleteOverrideDialogMessage: { message: Dialog.Message },
	CompletedDeleteOverride: { overrideId: OnCallOverrideId, result: LoadOutcome(Schema.Void) },
})
export type Message = typeof Message.Type
