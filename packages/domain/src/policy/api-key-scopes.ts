import { Array as Arr, Option, String as Str } from "effect"
import type { Permission } from "./permissions"

/**
 * The v2 resource families an API key can be scoped to, and the permission each access needs from
 * someone who creates restricted keys without `api_keys:manage`. A family that names none is open
 * to anyone who may create restricted keys. Write includes read, so it needs both.
 */
export const apiKeyScopeFamilies = [
	{ id: "api_keys", label: "API keys", write: "api_keys:manage" },
	{ id: "dashboards", label: "Dashboards" },
	{ id: "alerts", label: "Alerts", write: "alerts:manage" },
	{ id: "ingest_keys", label: "Ingest keys", read: "ingest_keys:view", write: "ingest_keys:roll" },
	{ id: "attribute_mappings", label: "Attribute mappings", write: "attribute_mappings:manage" },
	{ id: "scrape_targets", label: "Scrape targets", write: "scrape_targets:manage" },
	{ id: "slos", label: "SLOs" },
	{ id: "uptime_monitors", label: "Uptime monitors", write: "uptime_monitors:manage" },
	{ id: "ingest_rules", label: "Ingest rules", write: "ingest_rules:manage" },
	{ id: "data_sources", label: "Data sources", write: "data_sources:manage" },
	{ id: "status_pages", label: "Status pages", write: "status_pages:edit" },
	{ id: "status_page_incidents", label: "Status page incidents", write: "status_page_incidents:post" },
	{ id: "instrumentation", label: "Recommendations", write: "recommendations:triage" },
	{ id: "investigations", label: "Investigations", write: "investigations:run" },
	{ id: "error_issues", label: "Errors", write: "error_issues:triage" },
	{ id: "anomalies", label: "Anomalies", write: "anomalies:configure" },
	{ id: "session_replays", label: "Session replays" },
	{ id: "source_maps", label: "Source maps", write: "source_maps:upload" },
	{ id: "traces", label: "Traces" },
	{ id: "logs", label: "Logs" },
	{ id: "metrics", label: "Metrics" },
	{ id: "services", label: "Services" },
	{ id: "service_map", label: "Service map" },
	{ id: "sources", label: "Sources", write: "sources:manage" },
	{ id: "integrations", label: "Integrations", write: "integrations:manage" },
	{ id: "query", label: "Query" },
	{ id: "organization", label: "Organization", write: "organization:manage" },
	{ id: "audit_log", label: "Audit log", read: "audit_log:read" },
] as const satisfies ReadonlyArray<{
	readonly id: string
	readonly label: string
	readonly read?: Permission
	readonly write?: Permission
}>

export type ApiKeyScopeFamily = (typeof apiKeyScopeFamilies)[number]
export type ScopeAccess = "read" | "write"

const permissionsFor = (family: ApiKeyScopeFamily, access: ScopeAccess): ReadonlyArray<Permission> => [
	...("read" in family ? [family.read] : []),
	...(access === "write" && "write" in family ? [family.write] : []),
]

/** Whether someone holding `holds` may put `access` on `family` on a restricted key. */
export const canGrantFamily = (
	holds: (permission: Permission) => boolean,
	family: ApiKeyScopeFamily,
	access: ScopeAccess,
): boolean => Arr.every(permissionsFor(family, access), holds)

/**
 * Whether every scope in `scopes` is one `holds` may grant. `*`, an unknown family and an empty
 * list are not: a restricted key names its families.
 */
export const canGrantScopes = (
	holds: (permission: Permission) => boolean,
	scopes: ReadonlyArray<string> | null | undefined,
): boolean =>
	scopes != null &&
	scopes.length > 0 &&
	Arr.every(scopes, (scope) => {
		const [id, access] = Str.split(":")(scope)
		if (access !== "read" && access !== "write") return false
		return Option.match(
			Arr.findFirst(apiKeyScopeFamilies, (family) => family.id === id),
			{ onNone: () => false, onSome: (family) => canGrantFamily(holds, family, access) },
		)
	})
