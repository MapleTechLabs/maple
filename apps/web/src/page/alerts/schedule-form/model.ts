import * as Policy from "@maple/domain/policy"
import { OnCallScheduleId } from "@maple/domain/http"
import { V2OnCallSchedule } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import * as Menu from "@maple/views/ui/menu"
import { AlertsScheduleNewSearch } from "../../../route/search"
import { OrgMember } from "../shared/org-members"
import { Form } from "./form"

// `/alerts/schedules/new`: create an on-call schedule, or edit one (`?scheduleId=`).

export const Model = Schema.Struct({
	search: AlertsScheduleNewSearch,
	/** The schedule being edited; `null` creates. */
	editingId: Schema.NullOr(OnCallScheduleId),
	/** The edited schedule's read; the form fills from it once. */
	existing: KeyedSchema(V2OnCallSchedule, LoadFailure),
	form: Form,
	/** The browser's zone and clock arrived: a new form starts from them. */
	isReady: Schema.Boolean,
	nowMs: Schema.Number,
	/** Every IANA zone the browser knows, for the zone picker. */
	zones: Schema.Array(Schema.String),
	zonePicker: Combobox.Model,
	members: Schema.NullOr(Schema.Array(OrgMember)),
	membersError: Schema.NullOr(Schema.String),
	/** Each layer's "Add person" menu, by layer key. */
	menus: Schema.Record(Schema.String, Menu.Model),
	isSaving: Schema.Boolean,
	/** A save was tried: each field shows what is wrong with it. */
	isShowingErrors: Schema.Boolean,
	saveFailure: Schema.NullOr(LoadFailure),
	grants: Schema.Array(Policy.PermissionName),
	isSessionLoaded: Schema.Boolean,
})
export type Model = typeof Model.Type

/** The viewer may change schedules (`alerts:manage`); the API refuses anyone else. */
export const canManage = (model: Pick<Model, "grants">): boolean => Policy.has(model.grants, "alerts:manage")
