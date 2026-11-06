import * as Policy from "@maple/domain/policy"
import { SloId } from "@maple/domain"
import { V2Slo } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Menu from "@maple/views/ui/menu"
import { AlertsSloNewSearch } from "../../../route/search"
import { Form } from "./form"

// `/alerts/slos/new`: create an SLO, or edit one (`?sloId=`).

export const Model = Schema.Struct({
	search: AlertsSloNewSearch,
	/** The SLO being edited; `null` creates. */
	editingId: Schema.NullOr(SloId),
	/** The edited SLO's read; the form fills from it once. */
	existing: KeyedSchema(V2Slo, LoadFailure),
	form: Form,
	isSaving: Schema.Boolean,
	/** The last save's failure, shown beside the action bar. */
	saveFailure: Schema.NullOr(LoadFailure),
	/** The org's traced services of the last day, for the Service select. */
	services: Schema.Array(Schema.String),
	destinations: Schema.NullOr(Schema.Array(AlertDestinationRowSchema)),
	criticalMenu: Menu.Model,
	warningMenu: Menu.Model,
	grants: Schema.Array(Policy.PermissionName),
	/** The session answered; until then a member is not yet told the form is admin-only. */
	isSessionLoaded: Schema.Boolean,
})
export type Model = typeof Model.Type

/** The viewer may change SLOs (`alerts:manage`); the API refuses anyone else. */
export const canManage = (model: Pick<Model, "grants">): boolean => Policy.has(model.grants, "alerts:manage")
