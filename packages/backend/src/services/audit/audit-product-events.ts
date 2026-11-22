import type { AuditAction } from "@maple/domain/audit-actions"
import { Array as Arr, String as Str } from "effect"
import type { ProductEventInput } from "@maple/backend/services/product-events/ProductEventsService"
import type { AuditLogEvent } from "./audit-event"

/**
 * Audit actions that count as using a feature. Creations and connections show adoption; the
 * rest are the actions that show a feature is in use after setup. Updates, deletes and reads
 * stay out: they are frequent and say little about adoption.
 */
const FEATURE_ACTION_LIST: ReadonlyArray<AuditAction> = [
	// Alerting and on-call
	"alert_rule.created",
	"alert_destination.created",
	"alert_silence.created",
	"alert_maintenance_window.created",
	"escalation_chain.created",
	"oncall_schedule.created",
	// Dashboards
	"dashboard.created",
	"dashboard_share.created",
	// Reliability
	"slo.created",
	"uptime_monitor.created",
	"status_page.created",
	"status_page.published",
	"status_page_incident.created",
	"status_page_incident.update_posted",
	// Data in
	"source.created",
	"scrape_target.created",
	"ingest_rule.created",
	"attribute_mapping.created",
	"data_source.created",
	"api_key.created",
	// Integrations
	"aws_connection.created",
	"gcp_connector.created",
	"vercel_integration.connected",
	"planetscale_integration.organization_selected",
	"chat_integration.install_started",
	"code_review.repository_enabled",
	"cost_source.created",
	"mcp_connection.granted",
	"cli_session.approved",
	// Errors, anomalies and investigations
	"error_issue.state_change",
	"error_issue.assignment",
	"error_issue.snooze",
	"error_issue.comment",
	"anomaly_incident.resolved",
	"investigation.created",
	"investigation.restarted",
]

/** Typed by the list above, so a renamed or removed action is a type error there. */
const FEATURE_ACTIONS: ReadonlySet<string> = new Set(FEATURE_ACTION_LIST)

/**
 * The `feature_used` product event for an audit entry, or `undefined` when the entry is not a
 * feature action. Only allowed actions by a person, an API key or an agent count: system
 * actions (auto-resolve, scheduled jobs) are Maple acting, not the customer.
 *
 * Queue redelivery can repeat an entry, so `audit_entry_id` lets a count take `uniq` over it.
 */
export const featureUsedEvent = (event: AuditLogEvent): ProductEventInput | undefined => {
	if (event.outcome !== "allowed" || event.actorType === "system") return undefined
	if (!FEATURE_ACTIONS.has(event.action)) return undefined
	const [feature, action] = Str.split(".")(event.action)
	if (feature === undefined || action === undefined) return undefined
	return {
		name: "feature_used",
		groupId: event.orgId,
		...(event.userId === undefined ? undefined : { userId: event.userId }),
		timestamp: event.occurredAtMs,
		attributes: {
			feature,
			action,
			source: event.source,
			actor_type: event.actorType,
			audit_entry_id: event.id,
			...(event.resourceId === undefined ? undefined : { resource_id: event.resourceId }),
			// An issue state change says where it went (`resolved`, `ignored`, ...).
			...(typeof event.metadata?.to_state === "string"
				? { to_state: event.metadata.to_state }
				: undefined),
		},
	}
}

/** The `feature_used` events for a batch of audit entries, in order. */
export const featureUsedEvents = (events: ReadonlyArray<AuditLogEvent>): ReadonlyArray<ProductEventInput> =>
	Arr.flatMap(events, (event) => {
		const productEvent = featureUsedEvent(event)
		return productEvent === undefined ? [] : [productEvent]
	})
