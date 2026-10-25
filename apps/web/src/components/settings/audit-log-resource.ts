import { auditResourceLabel } from "@maple/domain/audit-actions"
import { decodePublicId, PublicIdPrefixes, type V2AuditLogEntry } from "@maple/domain/http/v2"

type AuditEntryResource = Pick<
	V2AuditLogEntry,
	"action" | "resource_type" | "resource_id" | "affected_user" | "metadata"
>

/** Where a resource lives in the app. Only routes the web really has. */
export type AuditResourceLink =
	| { readonly to: "/alerts/$ruleId"; readonly params: { readonly ruleId: string } }
	| { readonly to: "/dashboards/$dashboardId"; readonly params: { readonly dashboardId: string } }
	| { readonly to: "/errors/issues/$issueId"; readonly params: { readonly issueId: string } }
	| { readonly to: "/investigations/$id"; readonly params: { readonly id: string } }
	| { readonly to: "/anomalies/$incidentId"; readonly params: { readonly incidentId: string } }
	| { readonly to: "/alerts"; readonly search: { readonly tab: "routing" } }
	| { readonly to: "/integrations"; readonly search: { readonly integration?: string } }
	| { readonly to: "/settings"; readonly search: { readonly tab: string } }

export interface AuditResourceDisplay {
	/** "Alert rule · High error rate", "API · POST /v1/deployments", or the bare type label. */
	readonly text: string
	readonly link: AuditResourceLink | null
}

const stringField = (metadata: Record<string, unknown> | null, key: string): string | null => {
	const value = metadata?.[key]
	return typeof value === "string" && value !== "" ? value : null
}

/** `alrt_YofPTrK9782DWwcnXhpcCw` -> `alrt_YofP`: enough to tell rows apart; the detail has the rest. */
export function shortPublicId(id: string): string {
	const separator = id.indexOf("_")
	if (separator === -1) return id.length > 8 ? id.slice(0, 8) : id
	return id.slice(0, separator + 5)
}

function resourceName(entry: AuditEntryResource, id: string | null): string | null {
	const { metadata } = entry
	return (
		stringField(metadata, "name") ??
		stringField(metadata, "tool") ??
		stringField(metadata, "key_type") ??
		stringField(metadata, "connector") ??
		(id !== null ? shortPublicId(id) : null)
	)
}

const decoded = (prefix: (typeof PublicIdPrefixes)[keyof typeof PublicIdPrefixes], id: string | null) =>
	id === null ? null : decodePublicId(prefix, id)

function resourceLink(entry: AuditEntryResource): AuditResourceLink | null {
	// A deleted resource has no page left to open.
	if (entry.action.endsWith(".deleted") || entry.action.endsWith(".removed")) return null
	const id = entry.resource_id
	switch (entry.resource_type) {
		case "alert_rule": {
			const ruleId = decoded(PublicIdPrefixes.alertRule, id)
			return ruleId === null ? null : { to: "/alerts/$ruleId", params: { ruleId } }
		}
		case "dashboard": {
			const dashboardId = decoded(PublicIdPrefixes.dashboard, id)
			return dashboardId === null ? null : { to: "/dashboards/$dashboardId", params: { dashboardId } }
		}
		case "error_issue": {
			const issueId = decoded(PublicIdPrefixes.errorIssue, id)
			return issueId === null ? null : { to: "/errors/issues/$issueId", params: { issueId } }
		}
		case "investigation": {
			const investigationId = decoded(PublicIdPrefixes.investigation, id)
			return investigationId === null
				? null
				: { to: "/investigations/$id", params: { id: investigationId } }
		}
		case "anomaly_incident": {
			const incidentId = decoded(PublicIdPrefixes.anomalyIncident, id)
			return incidentId === null ? null : { to: "/anomalies/$incidentId", params: { incidentId } }
		}
		case "alert_destination":
			return { to: "/alerts", search: { tab: "routing" } }
		case "scrape_target":
			return { to: "/integrations", search: { integration: "prometheus" } }
		case "gcp_connector":
			return { to: "/integrations", search: { integration: "gcp" } }
		case "planetscale_integration":
			return { to: "/integrations", search: { integration: "planetscale" } }
		case "chat_integration":
			return { to: "/integrations", search: {} }
		case "api_key":
		case "ingest_key":
			return { to: "/settings", search: { tab: "keys" } }
		case "member":
			return { to: "/settings", search: { tab: "members" } }
		case "attribute_mapping":
			return { to: "/settings", search: { tab: "ingestion" } }
		case "ai_provider_key":
			return { to: "/settings", search: { tab: "ai" } }
		case "warehouse_settings":
			return { to: "/settings", search: { tab: "data-platform" } }
		default:
			return null
	}
}

/** How the Resource column reads for an entry, or null when it acted on nothing. */
export function auditResourceDisplay(entry: AuditEntryResource): AuditResourceDisplay | null {
	// Membership changes act on a person: the affected user is the resource.
	const id = entry.resource_id ?? entry.affected_user
	// A refused request names its route, which says more than "API".
	const method = stringField(entry.metadata, "method")
	const path = stringField(entry.metadata, "path")
	if (method !== null && path !== null) return { text: `${method} ${path}`, link: null }
	if (entry.resource_type === null) {
		return id === null ? null : { text: shortPublicId(id), link: null }
	}
	const typeLabel = auditResourceLabel(entry.resource_type) ?? entry.resource_type
	const name = resourceName(entry, id)
	return {
		text: name === null ? typeLabel : `${typeLabel} · ${name}`,
		link: resourceLink(entry),
	}
}
