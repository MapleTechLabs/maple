import { OnCallWeekday, UserId } from "@maple/domain/http"
import { V2OnCallOverride, V2OnCallSchedule } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Combobox from "@maple/views/ui/combobox"
import * as Menu from "@maple/views/ui/menu"
import { OrgMember } from "../shared/org-members"
import { RangeDays } from "../shared/coverage-preview"
import { RotationKind } from "./form"
import { LoadOutcome } from "../../kit/load-schemas"
import { SessionGrants } from "../../kit/session-grants"

export const Direction = Schema.Literals(["up", "down"])
export type Direction = typeof Direction.Type

/** A layer's text fields. */
export const LayerField = Schema.Literals(["name", "handoffTime", "lengthHours", "startsAt"])
export type LayerField = typeof LayerField.Type

export const Message = defineMessageUnion({
	ReadDefaults: { timeZone: Schema.String, nowMs: Schema.Number, zones: Schema.Array(Schema.String) },
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchExisting: { key: Schema.String, result: LoadOutcome(V2OnCallSchedule) },
	ClickedRetryExisting: {},
	CompletedFetchOverrides: { key: Schema.String, result: LoadOutcome(Schema.Array(V2OnCallOverride)) },
	ClickedRetryOverrides: {},
	CompletedFetchMembers: { result: Schema.Result(Schema.Array(OrgMember), Schema.String) },
	CompletedFetchSession: SessionGrants,
	ChangedName: { value: Schema.String },
	ChangedDescription: { value: Schema.String },
	GotZoneMessage: { message: Combobox.Message },
	ClickedAddLayer: {},
	ClickedRemoveLayer: { key: Schema.String },
	/** `up` raises the layer over the one above it, as the form draws them top first. */
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
	ClickedPreviewPrevious: {},
	ClickedPreviewNext: {},
	ClickedPreviewToday: {},
	PickedPreviewRange: { days: RangeDays },
	/** A gap in the summary: its bar on the timeline takes focus. */
	ClickedPreviewGap: { index: Schema.Number },
	CompletedFocusGap: {},
	ClickedSave: {},
	CompletedSave: { result: LoadOutcome(V2OnCallSchedule) },
})
export type Message = typeof Message.Type
