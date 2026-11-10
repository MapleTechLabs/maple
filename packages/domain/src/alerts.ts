// Stored shapes shared by the HTTP contract (`./http/alerts.ts`) and the Postgres tables.

import { Schema } from "effect"

export const AlertSeverity = Schema.Literals(["warning", "critical"]).annotate({
	identifier: "@maple/AlertSeverity",
	title: "Alert Severity",
})
export type AlertSeverity = Schema.Schema.Type<typeof AlertSeverity>

/** Facts about what an incident is about, for rules whose group key does not say (anomaly rules). */
export const AlertIncidentLabels = Schema.Struct({
	service: Schema.optionalKey(Schema.String),
	environment: Schema.optionalKey(Schema.String),
})
export type AlertIncidentLabels = Schema.Schema.Type<typeof AlertIncidentLabels>

/** `silenced`: written while an alert silence matched, never sent. */
export const AlertDeliveryStatus = Schema.Literals([
	"queued",
	"processing",
	"success",
	"failed",
	"silenced",
]).annotate({
	identifier: "@maple/AlertDeliveryStatus",
	title: "Alert Delivery Status",
})
export type AlertDeliveryStatus = Schema.Schema.Type<typeof AlertDeliveryStatus>

/** Where a page to a person stands: queued, out, refused, or dropped because the incident moved on. */
export const AlertIncidentPageStatus = Schema.Literals([
	"queued",
	"sending",
	"sent",
	"failed",
	"skipped",
]).annotate({
	identifier: "@maple/AlertIncidentPageStatus",
	title: "Alert Incident Page Status",
})
export type AlertIncidentPageStatus = Schema.Schema.Type<typeof AlertIncidentPageStatus>
