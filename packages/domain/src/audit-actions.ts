import { ErrorIssueEventType } from "./http/errors"
import { type PublicIdPrefix, PublicIdPrefixes } from "./http/v2/public-id"

/**
 * Every audited action in Maple, grouped by the resource it acts on.
 *
 * The key is both the `resource_type` stored on the row and the `<resource>`
 * half of the `<resource>.<verb>` action string, so the two can never disagree.
 * `prefix` is the public-ID prefix the resource's internal ID is encoded with;
 * resources that are org-singletons (`ingest_key`, `anomaly_settings`) or carry
 * no resource at all (`api`) omit it, and passing a `resourceId` for one of
 * those is a type error.
 *
 * Adding an entry here is what makes `record({ action: "<resource>.<verb>" })`
 * compile: a typo, or an action recorded before it is declared, fails the build.
 */
export const AuditResources = {
	agent: { prefix: PublicIdPrefixes.actor, verbs: ["registered"] },
	/** Feedback about Maple sent by an agent; kind and agent type are in `metadata`. */
	agent_feedback: { prefix: PublicIdPrefixes.agentFeedback, verbs: ["submitted"] },
	/** Org-singleton OpenRouter key the org's AI turns run on; the key is never in `changes`. */
	ai_provider_key: { verbs: ["updated", "deleted"] },
	alert_destination: {
		prefix: PublicIdPrefixes.alertDestination,
		verbs: ["created", "updated", "deleted"],
	},
	alert_rule: { prefix: PublicIdPrefixes.alertRule, verbs: ["created", "updated", "deleted"] },
	anomaly_incident: { prefix: PublicIdPrefixes.anomalyIncident, verbs: ["resolved"] },
	/** Org-singleton settings, no resource id. */
	anomaly_settings: { verbs: ["updated"] },
	/** Refused requests, recorded by the auth layers; the route is in `metadata`. */
	api: { verbs: ["request"] },
	api_key: { prefix: PublicIdPrefixes.apiKey, verbs: ["created", "rolled", "revoked"] },
	attribute_mapping: {
		prefix: PublicIdPrefixes.attributeMapping,
		verbs: ["created", "updated", "deleted"],
	},
	dashboard: {
		prefix: PublicIdPrefixes.dashboard,
		verbs: ["created", "updated", "deleted", "version_restored"],
	},
	/**
	 * Chat workspaces linked to the org. `install_started` is the admin action
	 * Maple sees; the platform's callback completes the link. `metadata` names
	 * the connector; the platform is a value here, never part of the action.
	 *
	 * `identity_*` are the per-member half: one person binding their own chat
	 * account to their Maple user, which is standing authority to act as them from
	 * the chat platform. `identity_link_started` records the member starting it, the
	 * platform's callback completes it, and neither carries a resource id: the
	 * subject of both is the actor.
	 */
	chat_integration: {
		prefix: PublicIdPrefixes.chatWorkspace,
		verbs: [
			"install_started",
			"settings_updated",
			"uninstalled",
			"identity_link_started",
			"identity_unlinked",
		],
	},
	dashboard_share: { prefix: PublicIdPrefixes.dashboardShare, verbs: ["created", "rotated", "deleted"] },
	/** A device-held key registered for the mobile widgets (DPoP); keyed by installation. */
	device_credential: { prefix: PublicIdPrefixes.deviceCredential, verbs: ["registered", "revoked"] },
	/** Verbs mirror the issue event types: `recordEvent` audits every one it attributes. */
	error_issue: { prefix: PublicIdPrefixes.errorIssue, verbs: ErrorIssueEventType.literals },
	/** One connected Google Cloud scope; the scope and what it collects are in `metadata`. */
	gcp_connector: {
		prefix: PublicIdPrefixes.gcpConnector,
		verbs: ["created", "updated", "removal_confirmed", "deleted"],
	},
	/** One connected AWS account; the account and its modules are in `metadata`. */
	aws_connection: {
		prefix: PublicIdPrefixes.awsConnection,
		verbs: ["created", "updated", "deleted"],
	},
	/** Anything that sends data; a token source's secret is never in `changes`. */
	source: {
		prefix: PublicIdPrefixes.source,
		verbs: ["created", "updated", "paused", "resumed", "rolled", "deleted"],
	},
	/** Org-singleton public/private pair; which one rolled is in `metadata`. */
	ingest_key: { verbs: ["rolled"] },
	/**
	 * Every MCP tool invocation, whichever surface drove it (MCP transport, the
	 * in-app chat, workflows, internal RPC). The tool and its parameters are in
	 * `metadata`; a tool that also mutates a resource records that action too.
	 */
	/** An MCP client's OAuth grant; the client and the member who approved it are in `metadata`. */
	mcp_connection: { prefix: PublicIdPrefixes.mcpConnection, verbs: ["revoked"] },
	mcp_tool: { verbs: ["called"] },
	investigation: {
		prefix: PublicIdPrefixes.investigation,
		verbs: ["created", "restarted", "status_changed"],
	},
	/** Org-singleton credit; the amount is in `metadata`. */
	onboarding_reward: { verbs: ["claimed"] },
	/**
	 * Org-singleton connections. `*_started` is the admin action Maple sees; the
	 * OAuth round trip completes at the provider's callback.
	 */
	planetscale_integration: {
		verbs: ["connect_started", "organization_selected", "metrics_token_set", "disconnected"],
	},
	/**
	 * Org membership, learned from Clerk's webhook; the web app changes members
	 * in Clerk directly, so nothing reaches Maple's own API. The member is the
	 * entry's `affected_user`; no prefix, since Clerk IDs are already public.
	 */
	member: { verbs: ["added", "role_changed", "removed"] },
	/**
	 * The org itself. No prefix: every row already carries `org_id`, and a
	 * deleted org has no public ID left to resolve.
	 */
	organization: { verbs: ["deleted", "region_chosen"] },
	scrape_target: { prefix: PublicIdPrefixes.scrapeTarget, verbs: ["created", "updated", "deleted"] },
	/**
	 * Reads of recorded browser sessions, the surface most likely to carry
	 * end-user data. Recorded by the auth layers from the `AuditedRead` annotation.
	 */
	session_replay: { verbs: ["read"] },
	/** Org-singleton shared Slack channel; the invited email is in `metadata`. */
	support_channel: { verbs: ["created", "invite_sent"] },
	/**
	 * Reads of traces, logs, metrics and error events (`read`, from the
	 * `AuditedRead` annotation on the endpoint) and every raw SQL statement run
	 * against the warehouse (`sql_executed`, with the statement in `metadata`).
	 */
	telemetry: { verbs: ["read", "sql_executed"] },
	/** Org-singleton BYO-ClickHouse connection; holds warehouse credentials. */
	warehouse_settings: { verbs: ["updated", "deleted", "schema_applied"] },
	/** Short-lived device credentials for the mobile widget; keyed by installation. */
	widget_credential: { verbs: ["minted", "revoked"] },
} as const satisfies Record<string, AuditResourceDefinition>

interface AuditResourceDefinition {
	readonly prefix?: PublicIdPrefix
	readonly verbs: ReadonlyArray<string>
}

export type AuditResourceType = keyof typeof AuditResources

/** `<resource>.<verb>` for every declared pair: the closed set of audit actions. */
export type AuditAction = {
	[K in AuditResourceType]: `${K}.${(typeof AuditResources)[K]["verbs"][number]}`
}[AuditResourceType]

/** What each kind of resource is called in the UI. */
export const AuditResourceLabels = {
	agent: "Agent",
	agent_feedback: "Agent feedback",
	ai_provider_key: "AI provider key",
	alert_destination: "Alert destination",
	alert_rule: "Alert rule",
	anomaly_incident: "Anomaly",
	anomaly_settings: "Anomaly detection",
	api: "API",
	api_key: "API key",
	attribute_mapping: "Attribute mapping",
	dashboard: "Dashboard",
	chat_integration: "Chat integration",
	dashboard_share: "Dashboard share",
	device_credential: "Device credential",
	error_issue: "Issue",
	gcp_connector: "Google Cloud connector",
	aws_connection: "AWS connection",
	ingest_key: "Ingest key",
	mcp_connection: "MCP connection",
	mcp_tool: "MCP tool",
	investigation: "Investigation",
	onboarding_reward: "Onboarding reward",
	planetscale_integration: "PlanetScale integration",
	member: "Member",
	organization: "Organization",
	scrape_target: "Scrape target",
	source: "Source",
	session_replay: "Session replay",
	support_channel: "Support channel",
	telemetry: "Telemetry",
	warehouse_settings: "Warehouse connection",
	widget_credential: "Widget credential",
} as const satisfies Record<AuditResourceType, string>

/** A sentence-case label per audited action; the type makes a missing one a build error. */
export const AuditActionLabels = {
	"agent.registered": "Registered agent",
	"agent_feedback.submitted": "Sent feedback",
	"ai_provider_key.updated": "Updated AI provider key",
	"ai_provider_key.deleted": "Removed AI provider key",
	"alert_destination.created": "Created alert destination",
	"alert_destination.updated": "Updated alert destination",
	"alert_destination.deleted": "Deleted alert destination",
	"alert_rule.created": "Created alert rule",
	"alert_rule.updated": "Updated alert rule",
	"alert_rule.deleted": "Deleted alert rule",
	"anomaly_incident.resolved": "Resolved anomaly",
	"anomaly_settings.updated": "Updated anomaly detection",
	"api.request": "Made API request",
	"api_key.created": "Created API key",
	"api_key.rolled": "Rolled API key",
	"api_key.revoked": "Revoked API key",
	"attribute_mapping.created": "Created attribute mapping",
	"attribute_mapping.updated": "Updated attribute mapping",
	"attribute_mapping.deleted": "Deleted attribute mapping",
	"dashboard.created": "Created dashboard",
	"dashboard.updated": "Updated dashboard",
	"dashboard.deleted": "Deleted dashboard",
	"dashboard.version_restored": "Restored dashboard version",
	"chat_integration.install_started": "Started chat integration install",
	"chat_integration.settings_updated": "Updated chat integration",
	"chat_integration.uninstalled": "Uninstalled chat integration",
	"chat_integration.identity_link_started": "Started linking chat account",
	"chat_integration.identity_unlinked": "Unlinked chat account",
	"dashboard_share.created": "Shared dashboard",
	"dashboard_share.rotated": "Rotated dashboard share link",
	"dashboard_share.deleted": "Removed dashboard share link",
	"device_credential.registered": "Registered device key",
	"device_credential.revoked": "Revoked device key",
	"error_issue.created": "Created issue",
	"error_issue.state_change": "Changed issue status",
	"error_issue.assignment": "Assigned issue",
	"error_issue.claim": "Claimed issue",
	"error_issue.release": "Released issue",
	"error_issue.lease_expired": "Issue claim expired",
	"error_issue.comment": "Commented on issue",
	"error_issue.agent_note": "Added agent note to issue",
	"error_issue.fix_proposed": "Proposed fix for issue",
	"error_issue.regression": "Issue regressed",
	"error_issue.snooze": "Snoozed issue",
	"error_issue.unsnooze": "Unsnoozed issue",
	"error_issue.ai_triage": "Triaged issue with AI",
	"error_issue.anomaly_linked": "Linked anomaly to issue",
	"error_issue.severity_change": "Changed issue severity",
	"error_issue.pr_linked": "Linked pull request to issue",
	"error_issue.pr_unlinked": "Unlinked pull request from issue",
	"error_issue.pr_merged": "Merged linked pull request",
	"error_issue.verification_started": "Started fix verification",
	"error_issue.verification_verdict": "Recorded fix verification result",
	"gcp_connector.created": "Connected Google Cloud",
	"gcp_connector.updated": "Updated Google Cloud connector",
	"gcp_connector.removal_confirmed": "Confirmed Google Cloud resources removed",
	"gcp_connector.deleted": "Removed Google Cloud connector",
	"aws_connection.created": "Connected AWS",
	"aws_connection.updated": "Updated AWS connection",
	"aws_connection.deleted": "Removed AWS connection",
	"ingest_key.rolled": "Rolled ingest key",
	"source.created": "Created source",
	"source.updated": "Updated source",
	"source.paused": "Paused source",
	"source.resumed": "Resumed source",
	"source.rolled": "Rolled source token",
	"source.deleted": "Deleted source",
	"mcp_connection.revoked": "Revoked MCP connection",
	"mcp_tool.called": "Called MCP tool",
	"investigation.created": "Started investigation",
	"investigation.restarted": "Restarted investigation",
	"investigation.status_changed": "Changed investigation status",
	"onboarding_reward.claimed": "Claimed onboarding reward",
	"planetscale_integration.connect_started": "Started PlanetScale connection",
	"planetscale_integration.organization_selected": "Selected PlanetScale organization",
	"planetscale_integration.metrics_token_set": "Set PlanetScale metrics token",
	"planetscale_integration.disconnected": "Disconnected PlanetScale",
	"member.added": "Added member",
	"member.role_changed": "Changed member role",
	"member.removed": "Removed member",
	"organization.deleted": "Deleted organization",
	"organization.region_chosen": "Chose data region",
	"scrape_target.created": "Created scrape target",
	"scrape_target.updated": "Updated scrape target",
	"scrape_target.deleted": "Deleted scrape target",
	"session_replay.read": "Viewed session replay",
	"support_channel.created": "Created support channel",
	"support_channel.invite_sent": "Sent support channel invite",
	"telemetry.read": "Read telemetry",
	"telemetry.sql_executed": "Ran SQL query",
	"warehouse_settings.updated": "Updated warehouse connection",
	"warehouse_settings.deleted": "Disconnected warehouse",
	"warehouse_settings.schema_applied": "Applied warehouse schema",
	"widget_credential.minted": "Issued widget credential",
	"widget_credential.revoked": "Revoked widget credential",
} as const satisfies Record<AuditAction, string>

/** Every declared `<resource>.<verb>`, in catalog order. */
export const auditActions = (): ReadonlyArray<string> =>
	Object.entries(AuditResources).flatMap(([resource, { verbs }]) =>
		verbs.map((verb) => `${resource}.${verb}`),
	)

const isAuditAction = (action: string): action is AuditAction => Object.hasOwn(AuditActionLabels, action)
const isAuditResourceType = (type: string): type is AuditResourceType =>
	Object.hasOwn(AuditResourceLabels, type)

/** Label for an action string read off a row; null for one this build does not know. */
export const auditActionLabel = (action: string): string | null =>
	isAuditAction(action) ? AuditActionLabels[action] : null

/** Label for a `resource_type` read off a row; null for one this build does not know. */
export const auditResourceLabel = (type: string): string | null =>
	isAuditResourceType(type) ? AuditResourceLabels[type] : null
