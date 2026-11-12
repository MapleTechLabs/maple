import { isAuditAccessAction } from "@maple/domain/audit-actions"
import type { AuditTrailCategory, AuditTrailEvent } from "@maple/domain/audit-trail"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { Array as Arr, Option, Record as Rec } from "effect"
import type { AuditAction, AuditResourceType } from "@maple/domain/audit-actions"
import type { AuditLogEvent } from "@maple/backend/services/audit/audit-event"

/**
 * What each Maple resource's actions are about. Complete on purpose: a new audited resource
 * does not compile until someone decides where it belongs in the trail.
 */
const CATEGORY_BY_RESOURCE = {
	agent: "resource",
	agent_feedback: "other",
	ai_provider_key: "credential",
	alert_destination: "configuration",
	alert_rule: "configuration",
	alert_silence: "configuration",
	alert_maintenance_window: "configuration",
	anomaly_incident: "resource",
	anomaly_settings: "configuration",
	// The only `api` action is a refused request: a credential that did not get in.
	api: "authentication",
	api_key: "credential",
	attribute_mapping: "configuration",
	ingest_rule: "configuration",
	data_source: "configuration",
	dashboard: "resource",
	chat_integration: "configuration",
	// A share link is a grant: it lets someone without an account read the dashboard.
	dashboard_share: "permission",
	device_credential: "credential",
	error_issue: "resource",
	escalation_chain: "configuration",
	oncall_schedule: "configuration",
	oncall_override: "configuration",
	gcp_connector: "configuration",
	aws_connection: "configuration",
	source: "configuration",
	ingest_key: "credential",
	mcp_connection: "configuration",
	mcp_tool: "data_access",
	investigation: "resource",
	onboarding_reward: "billing",
	planetscale_integration: "configuration",
	cloudflare_integration: "configuration",
	member: "membership",
	organization: "configuration",
	scrape_target: "configuration",
	uptime_monitor: "configuration",
	slo: "configuration",
	status_page: "resource",
	status_page_component: "resource",
	status_page_incident: "resource",
	security_audit_finding: "resource",
	security_audit_run: "resource",
	security_audit_settings: "configuration",
	session_replay: "data_access",
	support_channel: "configuration",
	telemetry: "data_access",
	vercel_integration: "configuration",
	warehouse_settings: "configuration",
	widget_credential: "credential",
} as const satisfies Record<AuditResourceType, AuditTrailCategory>

/** Actions about a secret or a grant on a resource whose other actions are not. */
const CATEGORY_BY_ACTION = {
	"source.rolled": "credential",
	"status_page.break_glass_rotated": "credential",
	"status_page.break_glass_revoked": "credential",
	"status_page.password_set": "credential",
	"status_page.password_removed": "credential",
	"planetscale_integration.metrics_token_set": "credential",
	"mcp_connection.revoked": "credential",
	// The link is standing authority to act as the member from the chat platform.
	"chat_integration.identity_link_started": "permission",
	"chat_integration.identity_unlinked": "permission",
} as const satisfies Partial<Record<AuditAction, AuditTrailCategory>>

const isAuditResourceType = (type: string): type is AuditResourceType =>
	Rec.has<string, AuditTrailCategory>(CATEGORY_BY_RESOURCE, type)

/** An entry from a build that knew a resource this one does not lands in `other`. */
const categoryOf = (event: AuditLogEvent): AuditTrailCategory =>
	Rec.get<string, AuditTrailCategory>(CATEGORY_BY_ACTION, event.action).pipe(
		Option.getOrElse(() =>
			event.resourceType !== undefined && isAuditResourceType(event.resourceType)
				? CATEGORY_BY_RESOURCE[event.resourceType]
				: "other",
		),
	)

/** The actor's id in the public form the rest of the product shows. */
const actorOf = (event: AuditLogEvent): AuditTrailEvent["actor"] => {
	const name = event.actorLabel !== undefined ? { name: event.actorLabel } : undefined
	switch (event.actorType) {
		case "user":
			return {
				type: "user",
				...(event.userId !== undefined ? { id: event.userId } : undefined),
				...name,
			}
		case "api_key":
			return {
				type: "service",
				...(event.apiKeyId !== undefined
					? { id: encodePublicId(PublicIdPrefixes.apiKey, event.apiKeyId) }
					: undefined),
				...name,
			}
		case "agent":
			return {
				type: "service",
				...(event.actorId !== undefined
					? { id: encodePublicId(PublicIdPrefixes.actor, event.actorId) }
					: undefined),
				...name,
			}
		case "system":
			return { type: "system", ...name }
	}
}

/** What the trail's detail view shows of a Maple entry beyond the shared columns. */
const rawOf = (event: AuditLogEvent): Record<string, unknown> => ({
	source: event.source,
	...(event.denialReason !== undefined ? { denialReason: event.denialReason } : undefined),
	...(event.affectedUserId !== undefined ? { affectedUserId: event.affectedUserId } : undefined),
	...(event.changes !== undefined ? { changes: event.changes } : undefined),
	...(event.metadata !== undefined ? { metadata: event.metadata } : undefined),
	...(event.requestId !== undefined ? { requestId: event.requestId } : undefined),
})

/**
 * Maple's own audit entry as a trail event, or null for one the trail leaves out: an allowed
 * read, tool call or SQL run. A heavy agent user writes hundreds a day, and they would bury
 * every other platform's events. They stay in `audit_log`.
 */
const mapleAuditTrailEvent = (event: AuditLogEvent): AuditTrailEvent | null => {
	if (isAuditAccessAction(event.action) && event.outcome !== "denied") return null
	// A membership change names the member it happened to, not a resource id.
	const targetId = event.resourceId ?? event.affectedUserId
	const target =
		event.resourceType !== undefined || targetId !== undefined
			? {
					...(event.resourceType !== undefined ? { type: event.resourceType } : undefined),
					...(targetId !== undefined ? { id: targetId } : undefined),
				}
			: undefined
	return {
		provider: "maple",
		providerEventId: event.id,
		occurredAtMs: event.occurredAtMs,
		actor: actorOf(event),
		action: event.action,
		category: categoryOf(event),
		outcome: event.outcome === "denied" ? "denied" : "success",
		...(target !== undefined ? { target } : undefined),
		...(event.originIp !== undefined ? { originIp: event.originIp } : undefined),
		...(event.originCountry !== undefined ? { originCountry: event.originCountry } : undefined),
		raw: rawOf(event),
	}
}

/** The trail events for a batch of Maple's own audit entries. */
export const mapleAuditTrailEvents = (events: ReadonlyArray<AuditLogEvent>): ReadonlyArray<AuditTrailEvent> =>
	Arr.flatMap(events, (event) => {
		const trailEvent = mapleAuditTrailEvent(event)
		return trailEvent === null ? [] : [trailEvent]
	})
