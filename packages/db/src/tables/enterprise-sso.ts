import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/primitives"
import { Schema } from "effect"

export const SsoDomainStatus = Schema.Literals(["pending", "verified"])
export type SsoDomainStatus = typeof SsoDomainStatus.Type

/**
 * A domain an org claims for enterprise SSO. Maple issues the TXT challenge and checks DNS itself,
 * then marks the Clerk organization domain ownership-verified; only verified domains reach a connection.
 */
export const OrgSsoDomains = PG.table("org_sso_domains", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** Lower-cased, no trailing dot. */
		domain: PG.text,
		/** Published at `_maple-challenge.<domain>`; public by design, so stored as is. */
		challenge: PG.text,
		status: PG.brand(PG.text, SsoDomainStatus),
		/** The Clerk organization domain, created once ownership is proven. */
		clerkDomainId: PG.column(PG.nullable(PG.text), { name: "clerk_domain_id" }),
		verifiedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "verified_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
	},
	primaryKey: ["orgId", "domain"],
	tenantColumn: "orgId",
})

export type OrgSsoDomainRow = PG.SelectRowOf<typeof OrgSsoDomains>

/**
 * The org's one enterprise connection and its SCIM directory, both held in Clerk. The ids live here
 * so a directory webhook finds its org, and only in the org's home region.
 */
export const OrgSsoConnections = PG.table("org_sso_connections", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		clerkConnectionId: PG.column(PG.text, { name: "clerk_connection_id" }),
		/** Null until SCIM provisioning is set up. The SCIM key itself is never stored. */
		clerkDirectoryId: PG.column(PG.nullable(PG.text), { name: "clerk_directory_id" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["orgId"],
	indexes: [
		PG.uniqueIndex("org_sso_connections_connection_unq", ["clerkConnectionId"]),
		PG.uniqueIndex("org_sso_connections_directory_unq", ["clerkDirectoryId"]),
	],
	tenantColumn: "orgId",
})

export type OrgSsoConnectionRow = PG.SelectRowOf<typeof OrgSsoConnections>

/**
 * Groups the IdP pushed over SCIM, from Clerk's `directoryGroup.*` webhooks: Clerk has no endpoint
 * that lists them, and the role mapping picker needs them.
 */
export const OrgDirectoryGroups = PG.table("org_directory_groups", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		directoryId: PG.column(PG.text, { name: "directory_id" }),
		/** The group id the directory assigned. */
		groupId: PG.column(PG.text, { name: "group_id" }),
		displayName: PG.column(PG.text, { name: "display_name" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		/** Set by `directoryGroup.deleted`; kept so a late, older event cannot revive the group. */
		deletedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "deleted_at" }),
	},
	primaryKey: ["directoryId", "groupId"],
	indexes: [PG.index("org_directory_groups_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

export type OrgDirectoryGroupRow = PG.SelectRowOf<typeof OrgDirectoryGroups>
