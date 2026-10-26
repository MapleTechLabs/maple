import { UptimeMonitorId } from "@maple/domain"
import { V2UptimeMonitor } from "@maple/domain/http/v2"
import { AlertDestinationRowSchema, AlertIncidentRowSchema } from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"

// `/alerts/uptime/$monitorId`: one monitor, its recent checks and setup.

const Rows = <S extends Schema.Top>(row: S) => Schema.NullOr(Schema.Array(row))

export const Model = Schema.Struct({
	/** The URL segment as written; `monitorId` is `null` when it is not a monitor id. */
	rawMonitorId: Schema.String,
	monitorId: Schema.NullOr(UptimeMonitorId),
	nowMs: Schema.NullOr(Schema.Number),
	monitor: KeyedSchema(V2UptimeMonitor, LoadFailure),
	/** Synced destinations (the Setup panel's names) and incidents (the open one, by rule name). */
	destinations: Rows(AlertDestinationRowSchema),
	incidents: Rows(AlertIncidentRowSchema),
	isAdmin: Schema.Boolean,
	isToggling: Schema.Boolean,
	isChecking: Schema.Boolean,
	/** The heartbeat's copy buttons, by snippet id. */
	copies: Schema.Record(Schema.String, CopyButton.Model),
})
export type Model = typeof Model.Type
