import { UptimeMonitorId } from "@maple/domain"
import { V2UptimeMonitor, V2UptimeMonitorTestResult } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { AlertsUptimeNewSearch } from "../../../route/search"
import * as Menu from "../../../ui/menu"
import { Form } from "./form"

// `/alerts/uptime/new`: create an uptime monitor, or edit one (`?monitorId=`).

export const Model = Schema.Struct({
	search: AlertsUptimeNewSearch,
	/** The monitor being edited; `null` creates. */
	editingId: Schema.NullOr(UptimeMonitorId),
	/** The edited monitor's read; the form fills from it once. */
	existing: KeyedSchema(V2UptimeMonitor, LoadFailure),
	form: Form,
	isSaving: Schema.Boolean,
	/** The last save's failure, shown beside the action bar: the plan's limit (402) or any other. */
	saveFailure: Schema.NullOr(LoadFailure),
	isTesting: Schema.Boolean,
	testResult: Schema.NullOr(V2UptimeMonitorTestResult),
	testFailure: Schema.NullOr(LoadFailure),
	/** The config the shown or in-flight test ran on; `null` once an edit makes it stale. */
	testedConfig: Schema.NullOr(Schema.String),
	/** The org's traced services of the last day, for the Service select. */
	services: Schema.Array(Schema.String),
	timeZones: Schema.Array(Schema.String),
	destinations: Schema.NullOr(Schema.Array(AlertDestinationRowSchema)),
	destinationMenu: Menu.Model,
	isAdmin: Schema.Boolean,
	/** The session answered; until then a member is not yet told the form is admin-only. */
	isSessionLoaded: Schema.Boolean,
})
export type Model = typeof Model.Type
