import * as Policy from "@maple/domain/policy"
import { OnCallWeekday, UserId } from "@maple/domain/http"
import { V2OnCallSchedule } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import * as Menu from "@maple/views/ui/menu"
import { OrgMember } from "../shared/org-members"
import { RotationKind } from "./form"

const outcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

export const Direction = Schema.Literals(["up", "down"])
export type Direction = typeof Direction.Type

/** A layer's text fields. */
export const LayerField = Schema.Literals(["name", "handoffTime", "lengthHours", "startsAt"])
export type LayerField = typeof LayerField.Type

export const Message = defineMessageUnion({
	ReadDefaults: { timeZone: Schema.String, nowMs: Schema.Number, zones: Schema.Array(Schema.String) },
	CompletedFetchExisting: { key: Schema.String, result: outcome(V2OnCallSchedule) },
	CompletedFetchMembers: { result: Schema.Result(Schema.Array(OrgMember), Schema.String) },
	CompletedFetchSession: { orgId: Schema.String, grants: Schema.Array(Policy.PermissionName) },
	ChangedName: { value: Schema.String },
	ChangedDescription: { value: Schema.String },
	GotZoneMessage: { message: Combobox.Message },
	ClickedAddLayer: {},
	ClickedRemoveLayer: { key: Schema.String },
	ClickedMoveLayer: { key: Schema.String, direction: Direction },
	ChangedLayerText: { key: Schema.String, field: LayerField, value: Schema.String },
	PickedRotation: { key: Schema.String, rotation: RotationKind },
	PickedHandoffWeekday: { key: Schema.String, weekday: OnCallWeekday },
	GotParticipantMenuMessage: { key: Schema.String, message: Menu.Message },
	ClickedRemoveParticipant: { key: Schema.String, userId: UserId },
	ClickedMoveParticipant: { key: Schema.String, userId: UserId, direction: Direction },
	ClickedAddRestriction: { key: Schema.String },
	ClickedRemoveRestriction: { key: Schema.String, restrictionKey: Schema.String },
	ToggledRestrictionDay: { key: Schema.String, restrictionKey: Schema.String, weekday: OnCallWeekday },
	ChangedRestrictionTime: {
		key: Schema.String,
		restrictionKey: Schema.String,
		edge: Schema.Literals(["start", "end"]),
		value: Schema.String,
	},
	ClickedSave: {},
	CompletedSave: { result: outcome(V2OnCallSchedule) },
})
export type Message = typeof Message.Type
