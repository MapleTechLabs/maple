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
	/** The plan's monitor allowance is used up (402 on create). */
	isLimitReached: Schema.Boolean,
	isTesting: Schema.Boolean,
	testResult: Schema.NullOr(V2UptimeMonitorTestResult),
	testFailure: Schema.NullOr(LoadFailure),
	/** The org's traced services of the last day, for the Service select. */
	services: Schema.Array(Schema.String),
	timeZones: Schema.Array(Schema.String),
	destinations: Schema.NullOr(Schema.Array(AlertDestinationRowSchema)),
	destinationMenu: Menu.Model,
	isAdmin: Schema.Boolean,
})
export type Model = typeof Model.Type
