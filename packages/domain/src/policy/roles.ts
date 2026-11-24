import { Array as Arr, Option, Record as Rec, Schema } from "effect"
import { type Permission, permissions, withImplied } from "./permissions"

/**
 * The built-in roles and the permissions each holds. A built-in role is only a preset list: nothing
 * ranks one above another, and a custom role (`org:custom`, see `custom-roles.ts`) is checked the
 * same way. `root` is Maple's own operator access and self-hosted mode; it is never assigned in
 * Clerk and holds everything.
 */
type Role = "analyst" | "member" | "engineer" | "admin" | "root"

/** The Clerk role a member on a custom role holds; their permissions are on the membership. */
export const CUSTOM_ROLE_CLERK_KEY = "org:custom"

const allPermissionKeys: ReadonlyArray<Permission> = Rec.keys(permissions)

const readAccess = [
	"telemetry:read",
	"query:sql",
	"dashboards:edit",
	"dashboards:share",
	"ai:ask",
	"devices:connect",
] as const satisfies ReadonlyArray<Permission>

const memberAccess = [
	...readAccess,
	"ai:act",
	"service_map:edit",
	"api_keys:create_mcp",
	"support:join",
	"ingest_keys:view_public",
	"error_issues:triage",
	"incidents:respond",
	"investigations:run",
	"status_page_incidents:post",
	"recommendations:triage",
] as const satisfies ReadonlyArray<Permission>

const engineerAccess = [
	...memberAccess,
	"integrations:manage",
	"code_review:configure",
	"scrape_targets:manage",
	"sources:manage",
	"alerts:manage",
	"oncall:manage",
	"slos:manage",
	"uptime_monitors:manage",
	"status_pages:edit",
	"ingest_rules:manage",
	"attribute_mappings:manage",
	"ingest_keys:view",
	"anomalies:configure",
	"error_policy:manage",
	"ai_triage:configure",
	"security:manage",
	"ingest_keys:roll",
	"source_maps:upload",
	"status_pages:access",
	"data_sources:manage",
	"data_sources:query",
	"api_keys:create_restricted",
] as const satisfies ReadonlyArray<Permission>

/** What the Members and Roles pages show for a built-in role, lowest first. */
export const builtInRoles = [
	{
		role: "analyst",
		clerkKey: "org:analyst",
		label: "Analyst",
		summary: "Read access only: telemetry, SQL, dashboards and Maple AI.",
		permissions: readAccess,
	},
	{
		role: "member",
		clerkKey: "org:member",
		label: "Member",
		summary: "Read access plus triage, incidents and Maple AI actions.",
		permissions: memberAccess,
	},
	{
		role: "engineer",
		clerkKey: "org:engineer",
		label: "Engineer",
		summary:
			"Also manages integrations, data sources, alerts, on-call, monitors, status pages, ingest setup and restricted API keys.",
		permissions: engineerAccess,
	},
	{
		role: "admin",
		clerkKey: "org:admin",
		label: "Admin",
		summary: "Everything, including billing, members, roles and single sign-on.",
		permissions: allPermissionKeys,
	},
] as const satisfies ReadonlyArray<{
	role: Exclude<Role, "root">
	clerkKey: string
	label: string
	summary: string
	permissions: ReadonlyArray<Permission>
}>

export type BuiltInRole = (typeof builtInRoles)[number]
export type ClerkRoleKey = BuiltInRole["clerkKey"]

/** A built-in role's Clerk key. */
export const BuiltInClerkRole = Schema.Literals(Arr.map(builtInRoles, (entry) => entry.clerkKey))
export type BuiltInClerkRole = typeof BuiltInClerkRole.Type

/** A built-in role's name, as the Roles page addresses it (`/settings/roles/engineer`). */
export const BuiltInRoleName = Schema.Literals(Arr.map(builtInRoles, (entry) => entry.role))
export type BuiltInRoleName = typeof BuiltInRoleName.Type

/** A Clerk role key the Members page may give: a built-in role, or the custom-role carrier. */
export const AssignableClerkRole = Schema.Literals([
	...Arr.map(builtInRoles, (entry) => entry.clerkKey),
	CUSTOM_ROLE_CLERK_KEY,
])
export type AssignableClerkRole = typeof AssignableClerkRole.Type

const analystRole = builtInRoles[0]
const memberRole = builtInRoles[1]

/** The built-in role a Clerk role key names. */
export const builtInRoleOf = (clerkKey: string): Option.Option<BuiltInRole> =>
	Arr.findFirst(builtInRoles, (entry) => entry.clerkKey === clerkKey)

/**
 * The permissions one role string holds. `custom` is what the membership carries for `org:custom`.
 * A role this code does not know reads as an analyst, and `org:custom` with nothing on the
 * membership holds nothing: both fail towards less. A custom set holds what it implies.
 */
export const permissionsOfRole = (
	role: string,
	custom: ReadonlyArray<Permission> | undefined,
): ReadonlyArray<Permission> => {
	if (role === "root") return allPermissionKeys
	if (role === CUSTOM_ROLE_CLERK_KEY) return withImplied(custom ?? [])
	return Option.match(builtInRoleOf(role), {
		onNone: () => analystRole.permissions,
		onSome: (entry) => entry.permissions,
	})
}

/** No roles at all reads as a member: a person's Clerk membership always carries one, so only Maple's own agents arrive without. */
export const NO_ROLE_PERMISSIONS: ReadonlyArray<Permission> = memberRole.permissions
