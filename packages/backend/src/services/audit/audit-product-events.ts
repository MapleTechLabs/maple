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
 * MCP tools that create without an audit entry of their own (their REST twins write one): the
 * successful `mcp_tool.called` entry stands in for it. Keyed `tool` or `tool:action` for a family.
 */
const MCP_CREATIONS: ReadonlyMap<string, AuditAction> = new Map<string, AuditAction>([
	["create_dashboard", "dashboard.created"],
	["create_alert_rule", "alert_rule.created"],
	["manage_alert_silence:create", "alert_silence.created"],
	["manage_maintenance_window:create", "alert_maintenance_window.created"],
	["manage_escalation_chain:create", "escalation_chain.created"],
	["manage_oncall_schedule:create", "oncall_schedule.created"],
	["manage_slo:create", "slo.created"],
	["manage_uptime_monitor:create", "uptime_monitor.created"],
	["manage_ingest_rule:create", "ingest_rule.created"],
])

/** The feature action an audit entry stands for, if any. */
const featureActionOf = (event: AuditLogEvent): string | undefined => {
	if (FEATURE_ACTIONS.has(event.action)) return event.action
	if (event.action !== "mcp_tool.called" || event.metadata?.is_error !== false) return undefined
	const tool = event.metadata.tool
	const toolAction = event.metadata.tool_action
	if (typeof tool !== "string") return undefined
	return MCP_CREATIONS.get(typeof toolAction === "string" ? `${tool}:${toolAction}` : tool)
}

/**
 * The `feature_used` product event for an audit entry, or `undefined` when the entry is not a
 * feature action. Only allowed actions by a person, an API key or an agent count: system
 * actions (auto-resolve, scheduled jobs) are Maple acting, not the customer.
 *
 * Queue redelivery can repeat an entry, so `audit_entry_id` lets a count take `uniq` over it.
 */
export const featureUsedEvent = (event: AuditLogEvent): ProductEventInput | undefined => {
	if (event.outcome !== "allowed" || event.actorType === "system") return undefined
	const featureAction = featureActionOf(event)
	if (featureAction === undefined) return undefined
	const [feature, action] = Str.split(".")(featureAction)
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
