import { UptimeMonitorId } from "@maple/domain"
import { AlertDeliveryEventDocument, AlertDestinationId, AlertRuleId } from "@maple/domain/http"
import { V2UptimeMonitor } from "@maple/domain/http/v2"
import {
	AlertDestinationRowSchema,
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { Schema } from "effect"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { AlertsSearch } from "../../../route/search"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import * as DestinationDialog from "../destination/dialog"

// The `/alerts` hub.

/** `useAlertDestinationsList` / the overview collections: `null` until the first live snapshot. */
const Rows = <S extends Schema.Top>(row: S) => Schema.NullOr(Schema.Array(row))

export const UptimeStatusFilter = Schema.Literals(["all", "down", "degraded", "paused"])
export const UptimeKindFilter = Schema.Literals(["all", "http", "tcp", "dns", "heartbeat"])
export type UptimeKindFilter = typeof UptimeKindFilter.Type

export const TestOutcome = Schema.Struct({ message: Schema.String, success: Schema.Boolean })

export const Model = Schema.Struct({
	search: AlertsSearch,
	/** `Clock.currentTimeMillis` when the overview model was built; `null` until read. */
	nowMs: Schema.NullOr(Schema.Number),
	rules: Rows(AlertRuleRowSchema),
	states: Rows(AlertRuleStateRowSchema),
	incidents: Rows(AlertIncidentRowSchema),
	destinations: Rows(AlertDestinationRowSchema),
	/** `alertDeliveries.list({ limit: 100 })`, newest first. */
	deliveries: KeyedSchema(Schema.Array(AlertDeliveryEventDocument), LoadFailure),
	/** The Routing tab's own `alertDeliveries.list` read, separate from `deliveries`. */
	routingDeliveries: KeyedSchema(Schema.Array(AlertDeliveryEventDocument), LoadFailure),
	/** `session.roles` has root or org:admin; `false` until the session answers. */
	isAdmin: Schema.Boolean,
	/** Rules tab: the search box and "Show all". */
	rulesQuery: Schema.String,
	isShowingAllRules: Schema.Boolean,
	/** The enable/disable PATCH in flight (`toggleRule.state`) and whether the last one failed. */
	togglingRuleId: Schema.NullOr(AlertRuleId),
	hasToggleFailed: Schema.Boolean,
	/** The rules or incidents stream stopped, or stalled, before its first answer. */
	isLoadFailed: Schema.Boolean,
	/** Routing: destinations with a test or delete in flight, and the one awaiting delete confirmation. */
	testingDestinationIds: Schema.Array(AlertDestinationId),
	deletingDestinationIds: Schema.Array(AlertDestinationId),
	confirmDeleteId: Schema.NullOr(AlertDestinationId),
	deleteDialog: Dialog.Model,
	/** Provider brand images that failed to load (`ProviderLogo`'s `errored`), by destination type. */
	brokenLogos: Schema.Array(Schema.String),
	/** Row action menus by menu id, created on first use. */
	menus: Schema.Record(Schema.String, Menu.Model),
	destinationDialog: DestinationDialog.Model,
	/** The header's "New rule" chevron menu (Telemetry rule, Uptime check). */
	newRuleMenu: Menu.Model,
	/** Uptime tab: `uptimeMonitors.list`, read only while the tab is open. */
	monitors: KeyedSchema(Schema.Array(V2UptimeMonitor), LoadFailure),
	uptimeQuery: Schema.String,
	uptimeStatus: UptimeStatusFilter,
	uptimeKind: UptimeKindFilter,
	/** Pause/resume PATCHes and the delete in flight, and the monitor awaiting delete confirmation. */
	togglingMonitorIds: Schema.Array(UptimeMonitorId),
	deletingMonitorId: Schema.NullOr(UptimeMonitorId),
	confirmDeleteMonitorId: Schema.NullOr(UptimeMonitorId),
	deleteMonitorDialog: Dialog.Model,
})
export type Model = typeof Model.Type
