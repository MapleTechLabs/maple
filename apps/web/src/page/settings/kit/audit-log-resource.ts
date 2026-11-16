import { auditResourceLabel, auditToolCallerLabel } from "@maple/domain/audit-actions"
import { internalAgentLabel } from "@maple/domain/system-agents"
import { decodePublicId, PublicIdPrefixes, type V2AuditLogEntry } from "@maple/domain/http/v2"
import { Option, String as Str } from "effect"

type AuditEntryResource = Pick<
	V2AuditLogEntry,
	"action" | "resource_type" | "resource_id" | "affected_user" | "metadata"
> &
	Partial<Pick<V2AuditLogEntry, "actor_name" | "actor_type">>

/**
 * The name frozen on an entry, with Maple's own agent names (`chat-connector-slack`) in words.
 * Agents only: an API key's name is free text, and one named like a Maple agent is still a key.
 */
export const auditActorName = (name: string | null, actorType: string | null | undefined): string | null =>
	name === null ? null : actorType === "agent" ? (internalAgentLabel(name) ?? name) : name

/** True when the actor column already names one of Maple's own agents for this entry. */
const actorIsMapleAgent = (entry: AuditEntryResource, caller: string): boolean =>
	entry.actor_name === caller ||
	(entry.actor_type === "agent" &&
		typeof entry.actor_name === "string" &&
		internalAgentLabel(entry.actor_name) !== null)

/** Where a resource lives in the app. Only routes the web really has. */
export type AuditResourceLink =
	| { readonly to: "/alerts/$ruleId"; readonly params: { readonly ruleId: string } }
	| { readonly to: "/dashboards/$dashboardId"; readonly params: { readonly dashboardId: string } }
	| { readonly to: "/errors/issues/$issueId"; readonly params: { readonly issueId: string } }
	| { readonly to: "/investigations/$id"; readonly params: { readonly id: string } }
	| { readonly to: "/anomalies/$incidentId"; readonly params: { readonly incidentId: string } }
	| { readonly to: "/alerts/routing" }
	| { readonly to: "/cost" }
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
	return Option.match(Str.indexOf("_")(id), {
		onNone: () => (id.length > 8 ? Str.slice(0, 8)(id) : id),
		onSome: (separator) => Str.slice(0, separator + 5)(id),
	})
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
	if (Str.endsWith(".deleted")(entry.action) || Str.endsWith(".removed")(entry.action)) return null
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
			return { to: "/alerts/routing" }
		case "scrape_target":
			return { to: "/integrations", search: { integration: "prometheus" } }
		case "gcp_connector":
			return { to: "/integrations", search: { integration: "gcp" } }
		case "planetscale_integration":
			return { to: "/integrations", search: { integration: "planetscale" } }
		case "cloudflare_integration":
			return { to: "/integrations", search: { integration: "cloudflare" } }
		case "linear_integration":
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
		case "cost_source_key":
		case "cost_source":
			return { to: "/cost" }
		case "warehouse_settings":
			return { to: "/settings", search: { tab: "data-platform" } }
		case "data_source":
			return { to: "/settings", search: { tab: "data-sources" } }
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
	// A tool call names who made it (a customer's MCP client or one of Maple's agents) and the tool's title.
	if (entry.resource_type === "mcp_tool") {
		const caller = auditToolCallerLabel(
			stringField(entry.metadata, "surface"),
			stringField(entry.metadata, "agent"),
		)
		const tool = stringField(entry.metadata, "tool_title") ?? stringField(entry.metadata, "tool")
		// The actor column already names Maple's agent (a code review pass, the chat bot); say the tool once.
		if (tool !== null && actorIsMapleAgent(entry, caller)) return { text: tool, link: null }
		return { text: tool === null ? caller : `${caller} · ${tool}`, link: null }
	}
	const typeLabel = auditResourceLabel(entry.resource_type) ?? entry.resource_type
	const name = resourceName(entry, id)
	return {
		text: name === null ? typeLabel : `${typeLabel} · ${name}`,
		link: resourceLink(entry),
	}
}
