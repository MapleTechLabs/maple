import * as Policy from "@maple/domain/policy"
import { OnCallOverrideId, OnCallScheduleId } from "@maple/domain/http"
import { V2OnCallOverride, V2OnCallSchedule, V2OnCallShifts } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { OrgMember } from "../shared/org-members"

// `/alerts/schedules/$scheduleId`: who is on call, the calendar of shifts, and the overrides.

/** The override form as typed: who, and from when to when on the schedule zone's wall clock. */
export const OverrideDraft = Schema.Struct({
	userId: Schema.String,
	startsAt: Schema.String,
	endsAt: Schema.String,
	/** The exact instants the dialog opened on, sent back until their text is edited. */
	startMs: Schema.NullOr(Schema.Number),
	endMs: Schema.NullOr(Schema.Number),
})
export type OverrideDraft = typeof OverrideDraft.Type

export const Model = Schema.Struct({
	rawScheduleId: Schema.String,
	scheduleId: Schema.NullOr(OnCallScheduleId),
	/** The clock, read on entry and by the hub cadence's tick. */
	nowMs: Schema.NullOr(Schema.Number),
	schedule: KeyedSchema(V2OnCallSchedule, LoadFailure),
	/** When the clock last asked for the schedule again; a failing read waits out the max age. */
	scheduleAskedAtMs: Schema.NullOr(Schema.Number),
	/** Weeks from this one the calendar shows: 0 is the week starting today. */
	weekOffset: Schema.Number,
	shifts: KeyedSchema(V2OnCallShifts, LoadFailure),
	overrides: KeyedSchema(Schema.Array(V2OnCallOverride), LoadFailure),
	/** `null` until Clerk answers, and after a failed read: names then read neutrally. */
	members: Schema.NullOr(Schema.Array(OrgMember)),
	/** The members read failed: the override form says so instead of offering nobody. */
	isMembersFailed: Schema.Boolean,
	grants: Schema.Array(Policy.PermissionName),
	overrideDialog: Dialog.Model,
	overrideDraft: OverrideDraft,
	isShowingOverrideErrors: Schema.Boolean,
	isCreatingOverride: Schema.Boolean,
	overrideError: Schema.NullOr(Schema.String),
	/** Bumped on every open: a create's result only settles the dialog it was sent from. */
	overrideOpenCount: Schema.Number,
	deletingOverrideId: Schema.NullOr(OnCallOverrideId),
	/** The override awaiting delete confirmation. */
	confirmDeleteOverrideId: Schema.NullOr(OnCallOverrideId),
	deleteOverrideDialog: Dialog.Model,
})
export type Model = typeof Model.Type

/** The viewer may change schedules and overrides (`alerts:manage`). */
export const canManage = (model: Pick<Model, "grants">): boolean => Policy.has(model.grants, "alerts:manage")
