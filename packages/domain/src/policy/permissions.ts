import type { Role } from "./roles"

/**
 * Every permission in Maple and the lowest role that holds it. This is the one place to read or
 * change who can do what: the API, the MCP tools and the dashboard all check against it.
 *
 * `action` finishes "Only org admins can ..." in denial messages and reads as a sentence fragment.
 * Not to be confused with `@maple/domain/permission`, which decides what an agent may run.
 */
export const permissions = {
	// The public ingest key ships in browser bundles, so every member may read it to set up an app.
	"ingest_keys:view_public": { min: "member", action: "view the public ingest key" },

	// Technical setup: engineers and above.
	"integrations:manage": { min: "engineer", action: "manage integrations" },
	"code_review:configure": { min: "engineer", action: "change code review settings" },
	"scrape_targets:manage": { min: "engineer", action: "manage scrape targets" },
	"sources:manage": { min: "engineer", action: "manage sources" },
	"alerts:manage": { min: "engineer", action: "manage alerts" },
	"uptime_monitors:manage": { min: "engineer", action: "manage uptime monitors" },
	"status_pages:edit": { min: "engineer", action: "edit status pages" },
	"ingest_rules:manage": { min: "engineer", action: "manage ingest rules" },
	"attribute_mappings:manage": { min: "engineer", action: "manage attribute mappings" },
	"ingest_keys:view": { min: "engineer", action: "view ingest keys" },
	"anomalies:configure": { min: "engineer", action: "manage anomaly detector settings" },
	"error_policy:manage": { min: "engineer", action: "manage error notifications and escalation" },
	"ai_triage:configure": { min: "engineer", action: "manage AI triage settings" },
	"security:manage": { min: "engineer", action: "read and triage security findings" },

	// The organization, money and credentials: admins only.
	"organization:manage": { min: "admin", action: "change the organization's settings" },
	"members:manage": { min: "admin", action: "manage members" },
	"billing:manage": { min: "admin", action: "manage billing" },
	"api_keys:manage": { min: "admin", action: "manage API keys" },
	"ingest_keys:roll": { min: "admin", action: "roll ingest keys" },
	"status_pages:break_glass": { min: "admin", action: "manage status page break-glass tokens" },
	"warehouse:manage": { min: "admin", action: "manage the data warehouse" },
	"security_audit:run": { min: "admin", action: "configure and run code security audits" },
	"audit_log:read": { min: "admin", action: "read the audit log" },
	"llm_keys:manage": { min: "admin", action: "manage the organization's model provider keys" },
	"mcp_connections:view_all": { min: "admin", action: "see every member's MCP connections" },
} as const satisfies Record<string, { readonly min: Role; readonly action: string }>

export type Permission = keyof typeof permissions
