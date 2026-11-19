/**
 * Every permission in Maple. This is the one place to read or change what a permission is: the API,
 * the MCP tools and the dashboard all check against it, and the built-in roles (`roles.ts`) are
 * lists of these keys.
 *
 * - `code` is the permission's stable number. Custom roles and pinned credentials store codes, not
 *   keys, so a code is never reused or renumbered; a retired permission keeps its number.
 * - `action` finishes "You need … to …" in denial messages and reads as a sentence fragment.
 * - `label` and `description` are what the role editor shows.
 * - `customRoles: false` keeps a permission out of custom roles: it stays with Admin.
 *
 * Not to be confused with `@maple/domain/permission`, which decides what an agent may run.
 */
export const permissionGroups = [
	{ id: "read", label: "Read access" },
	{ id: "everyday", label: "Everyday work" },
	{ id: "incidents", label: "Incident response" },
	{ id: "alerting", label: "Alerting and detection" },
	{ id: "status_pages", label: "Status pages" },
	{ id: "ingestion", label: "Ingestion and data" },
	{ id: "integrations", label: "Integrations and code" },
	{ id: "keys", label: "Keys and AI providers" },
	{ id: "organization", label: "Organization" },
] as const

export type PermissionGroup = (typeof permissionGroups)[number]["id"]

interface PermissionSpec {
	readonly code: number
	readonly group: PermissionGroup
	readonly label: string
	readonly description: string
	readonly action: string
	readonly sensitive?: true
	readonly customRoles?: false
}

export const permissions = {
	// Read access: what the Analyst role holds. Every other built-in role holds it too.
	"telemetry:read": {
		code: 36,
		group: "read",
		label: "Read telemetry",
		description: "Traces, logs, metrics, errors, sessions, incidents and the service map.",
		action: "read telemetry",
	},
	"query:sql": {
		code: 37,
		group: "read",
		label: "Run raw SQL",
		description: "Query the warehouse directly in Explore, the API and MCP.",
		action: "run raw SQL",
	},
	"dashboards:edit": {
		code: 38,
		group: "read",
		label: "Build dashboards",
		description: "Create and edit dashboards and widgets.",
		action: "build dashboards",
	},
	"dashboards:share": {
		code: 39,
		group: "read",
		label: "Share dashboards publicly",
		description: "Create, rotate and revoke public share links.",
		action: "share dashboards publicly",
		sensitive: true,
	},
	"ai:ask": {
		code: 40,
		group: "read",
		label: "Ask Maple AI",
		description: "Chat with Maple AI. Answers only; changes need Approve Maple AI actions.",
		action: "ask Maple AI",
	},
	"devices:connect": {
		code: 41,
		group: "read",
		label: "Connect devices and clients",
		description: "Sign in the mobile app, the CLI and MCP clients as yourself.",
		action: "connect devices and clients",
	},

	// Everyday work: what every role above Analyst does without a named permission today.
	"ai:act": {
		code: 42,
		group: "everyday",
		label: "Approve Maple AI actions",
		description: "Approve changes Maple AI proposes, and send chat messages that can act.",
		action: "approve Maple AI actions",
	},
	"service_map:edit": {
		code: 43,
		group: "everyday",
		label: "Edit the shared service map",
		description: "Arrange and annotate the organization's service map.",
		action: "edit the shared service map",
	},
	"api_keys:create_mcp": {
		code: 44,
		group: "everyday",
		label: "Create MCP keys",
		description: "API keys for your own MCP clients, pinned to your role.",
		action: "create MCP keys",
	},
	"support:join": {
		code: 45,
		group: "everyday",
		label: "Join the support channel",
		description: "Get invited to the organization's shared Slack channel with Maple.",
		action: "join the support channel",
	},

	// Incident response.
	"error_issues:triage": {
		code: 1,
		group: "incidents",
		label: "Triage error issues",
		description: "Assign, resolve, merge, comment on and set severity on error issues.",
		action: "triage error issues",
	},
	"incidents:respond": {
		code: 2,
		group: "incidents",
		label: "Respond to incidents",
		description: "Acknowledge and resolve alert and anomaly incidents.",
		action: "acknowledge and resolve incidents",
	},
	"investigations:run": {
		code: 3,
		group: "incidents",
		label: "Run investigations",
		description: "Start Maple AI investigations and follow-ups.",
		action: "start investigations",
	},
	"status_page_incidents:post": {
		code: 4,
		group: "incidents",
		label: "Post status page updates",
		description: "Open status page incidents and post updates to subscribers.",
		action: "post status page incidents and updates",
	},
	"recommendations:triage": {
		code: 5,
		group: "incidents",
		label: "Triage recommendations",
		description: "Dismiss and reopen instrumentation recommendations.",
		action: "dismiss and reopen recommendations",
	},

	// Alerting and detection.
	"alerts:manage": {
		code: 10,
		group: "alerting",
		label: "Manage alerts",
		description: "Alert rules, destinations, silences and maintenance windows.",
		action: "manage alerts",
	},
	"oncall:manage": {
		code: 46,
		group: "alerting",
		label: "Manage on-call schedules",
		description: "Schedules, overrides and escalation chains.",
		action: "manage on-call schedules",
	},
	"slos:manage": {
		code: 47,
		group: "alerting",
		label: "Manage SLOs and budgets",
		description: "Service level objectives and cost budgets.",
		action: "manage SLOs and budgets",
	},
	"uptime_monitors:manage": {
		code: 11,
		group: "alerting",
		label: "Manage uptime monitors",
		description: "Create, pause and delete HTTP and TCP checks.",
		action: "manage uptime monitors",
	},
	"error_policy:manage": {
		code: 17,
		group: "alerting",
		label: "Manage error notifications",
		description: "Who hears about new errors, and the escalation policy.",
		action: "manage error notifications and escalation",
	},
	"anomalies:configure": {
		code: 16,
		group: "alerting",
		label: "Configure anomaly detection",
		description: "Detector sensitivity and which services it watches.",
		action: "manage anomaly detector settings",
	},
	"ai_triage:configure": {
		code: 18,
		group: "alerting",
		label: "Configure AI triage",
		description: "When Maple AI triages new issues on its own.",
		action: "manage AI triage settings",
	},

	// Status pages.
	"status_pages:edit": {
		code: 12,
		group: "status_pages",
		label: "Edit status pages",
		description: "Components, monitors, appearance and custom domains.",
		action: "edit status pages",
	},
	"status_pages:access": {
		code: 21,
		group: "status_pages",
		label: "Control who can view status pages",
		description: "Make a page private and manage its viewers.",
		action: "change who can view status pages",
	},
	"status_pages:break_glass": {
		code: 28,
		group: "status_pages",
		label: "Manage break-glass tokens",
		description: "Tokens that post updates when Maple's own sign-in is down.",
		action: "manage status page break-glass tokens",
		sensitive: true,
	},

	// Ingestion and data.
	// The public ingest key ships in browser bundles, so every role above Analyst may read it.
	"ingest_keys:view_public": {
		code: 0,
		group: "ingestion",
		label: "View public ingest key",
		description: "The browser key that ships in app bundles.",
		action: "view the public ingest key",
	},
	"ingest_keys:view": {
		code: 15,
		group: "ingestion",
		label: "View ingest keys",
		description: "Read the private ingest keys.",
		action: "view ingest keys",
	},
	"ingest_keys:roll": {
		code: 20,
		group: "ingestion",
		label: "Roll ingest keys",
		description: "Replace an ingest key. Senders using the old key stop until updated.",
		action: "roll ingest keys",
		sensitive: true,
	},
	"sources:manage": {
		code: 9,
		group: "ingestion",
		label: "Manage sources",
		description: "Connect and remove telemetry sources.",
		action: "manage sources",
	},
	"ingest_rules:manage": {
		code: 13,
		group: "ingestion",
		label: "Manage ingest rules",
		description: "Drop, sample and redact data before it is stored.",
		action: "manage ingest rules",
	},
	"attribute_mappings:manage": {
		code: 14,
		group: "ingestion",
		label: "Manage attribute mappings",
		description: "Rename and remap attributes at ingest.",
		action: "manage attribute mappings",
	},
	"scrape_targets:manage": {
		code: 8,
		group: "ingestion",
		label: "Manage scrape targets",
		description: "Prometheus endpoints Maple scrapes.",
		action: "manage scrape targets",
	},
	"data_sources:manage": {
		code: 22,
		group: "ingestion",
		label: "Connect data sources",
		description: "External databases and APIs that Maple AI can query.",
		action: "connect and manage data sources",
	},
	"warehouse:manage": {
		code: 29,
		group: "ingestion",
		label: "Manage the data warehouse",
		description: "Bring-your-own ClickHouse connection and settings.",
		action: "manage the data warehouse",
		sensitive: true,
	},

	// Integrations and code.
	"integrations:manage": {
		code: 6,
		group: "integrations",
		label: "Manage integrations",
		description: "Connect, configure and remove integrations and cost sources.",
		action: "manage integrations",
	},
	"code_review:configure": {
		code: 7,
		group: "integrations",
		label: "Configure code review",
		description: "Which repositories Maple reviews, and the review rules.",
		action: "change code review settings",
	},
	// An approval counts toward a branch's required reviews, so who may give Maple that say is
	// an admin's call, and so are the rules a review runs under while it has it.
	"code_review:auto_approve": {
		code: 35,
		group: "integrations",
		label: "Turn on automatic PR approval",
		description: "Let Maple approve pull requests, and change the rules while it does.",
		action: "turn on automatic pull request approval or change the review rules while it is on",
		sensitive: true,
	},
	"security:manage": {
		code: 19,
		group: "integrations",
		label: "Open the Security Center",
		description: "See and triage security findings and dependency scans.",
		action: "open the Security Center and triage its findings",
	},
	"security_audit:run": {
		code: 30,
		group: "integrations",
		label: "Run code security audits",
		description: "Configure and start audits, which spend the audit budget.",
		action: "configure and run code security audits",
	},

	// Keys and AI providers.
	// Pinned to the creator's permissions, and only for the scopes they could use themselves.
	"api_keys:create_restricted": {
		code: 23,
		group: "keys",
		label: "Create restricted API keys",
		description: "Scoped keys limited to what the creator can do.",
		action: "create restricted API keys",
	},
	"api_keys:manage": {
		code: 27,
		group: "keys",
		label: "Manage all API keys",
		description: "Full-access keys, and every member's keys.",
		action: "manage API keys",
		sensitive: true,
	},
	"llm_keys:manage": {
		code: 32,
		group: "keys",
		label: "Manage model provider keys",
		description: "The organization's own OpenRouter and model provider keys.",
		action: "manage the organization's model provider keys",
		sensitive: true,
	},
	"mcp_connections:view_all": {
		code: 34,
		group: "keys",
		label: "See every MCP connection",
		description: "List and revoke every member's MCP clients.",
		action: "see every member's MCP connections",
	},

	// Organization. Members and roles stay with Admin: Clerk only lets its own admins invite and
	// remove people, and a role that may edit roles could grant itself everything.
	"organization:manage": {
		code: 24,
		group: "organization",
		label: "Manage the organization",
		description: "Rename, move or delete the organization.",
		action: "change the organization's settings",
		sensitive: true,
		customRoles: false,
	},
	"members:manage": {
		code: 25,
		group: "organization",
		label: "Manage members",
		description: "Invite and remove people and change their roles.",
		action: "manage members",
		sensitive: true,
		customRoles: false,
	},
	"roles:manage": {
		code: 48,
		group: "organization",
		label: "Manage roles",
		description: "Create, edit and delete custom roles.",
		action: "manage roles",
		sensitive: true,
		customRoles: false,
	},
	"billing:manage": {
		code: 26,
		group: "organization",
		label: "Manage billing",
		description: "Plans, payment methods, invoices and spend limits.",
		action: "manage billing",
		sensitive: true,
	},
	"sso:manage": {
		code: 33,
		group: "organization",
		label: "Manage single sign-on",
		description: "SAML connections and SCIM provisioning.",
		action: "manage single sign-on and SCIM provisioning",
		sensitive: true,
	},
	"audit_log:read": {
		code: 31,
		group: "organization",
		label: "Read the audit log",
		description: "Who changed what, and audit detections.",
		action: "read the audit log",
	},
} as const satisfies Record<string, PermissionSpec>

export type Permission = keyof typeof permissions
