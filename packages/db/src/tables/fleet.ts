import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/primitives"
import { Schema } from "effect"

/**
 * One Fleet server per Maple org, read with an API token (AES-GCM, bound to the org and the
 * server's origin). The row is also the poller's lease anchor and holds the server's failures.
 */
export const FleetConnections = PG.table("fleet_connections", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** The server's origin (`https://fleet.example.com`), plus a path prefix when it has one. */
		baseUrl: PG.column(PG.text, { name: "base_url" }),
		tokenCiphertext: PG.column(PG.text, { name: "token_ciphertext" }),
		tokenIv: PG.column(PG.text, { name: "token_iv" }),
		tokenTag: PG.column(PG.text, { name: "token_tag" }),
		/** The organization name the server reports, shown on the card and as the audit account. */
		organizationName: PG.column(PG.nullable(PG.text), { name: "organization_name" }),
		/** The token's user as Fleet names it, and its global role (`observer`, `admin`, ...). */
		apiUserName: PG.column(PG.nullable(PG.text), { name: "api_user_name" }),
		apiUserRole: PG.column(PG.nullable(PG.text), { name: "api_user_role" }),
		serverVersion: PG.column(PG.nullable(PG.text), { name: "server_version" }),
		/** `free` or `premium`, from the server's license. */
		licenseTier: PG.column(PG.nullable(PG.text), { name: "license_tier" }),
		/** The newest activity id stored in the audit log; the next poll reads after it. Null: never read. */
		activityCursor: PG.column(PG.nullable(PG.int8), { name: "activity_cursor" }),
		/**
		 * Ids below the cursor not seen yet: an id can commit after a higher one. The next reads
		 * write them if they appear, and drop them once they fall out of the overlap.
		 */
		activityGaps: PG.column(PG.nullable(PG.jsonb(Schema.Array(Schema.Number))), {
			name: "activity_gaps",
		}),
		connectedByUserId: PG.column(PG.brand(PG.text, UserId), { name: "connected_by_user_id" }),
		/** Set when Fleet rejected the token; polling stops until a new token is saved. */
		authFailedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "auth_failed_at" }),
		leaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "lease_until" }),
		/** A failed tick's back-off (rate limit, an unreachable server): no tick claims the row before it. */
		holdUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "hold_until" }),
		lastSuccessAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_success_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		lastErrorAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_error_at" }),
		/** The findings sync's own lease, hold and state: it runs apart from the activity poll. */
		findingsLeaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "findings_lease_until" }),
		findingsHoldUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "findings_hold_until" }),
		findingsSyncedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "findings_synced_at" }),
		findingsError: PG.column(PG.nullable(PG.text), { name: "findings_error" }),
		findingsErrorAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "findings_error_at" }),
		/** Enrolled devices at the last findings sync. */
		hostCount: PG.column(PG.nullable(PG.int4), { name: "host_count" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("fleet_connections_org_idx", ["orgId"]),
		// The findings' foreign key names the org with the id, so a row can only point at its own org's server.
		PG.uniqueIndex("fleet_connections_org_id_idx", ["orgId", "id"]),
	],
	tenantColumn: "orgId",
})

export type FleetConnectionRow = PG.SelectRowOf<typeof FleetConnections>

/** A device a finding names, as Fleet lists it; a sample, not every device. */
export const FleetFindingHost = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	platform: Schema.NullOr(Schema.String),
})
export type FleetFindingHost = typeof FleetFindingHost.Type

/** A global Fleet policy that at least one device fails. A policy every device passes has no row. */
export const FleetPolicyFindings = PG.table("fleet_policy_findings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		connectionId: PG.column(PG.text, { name: "connection_id" }),
		policyId: PG.column(PG.int8, { name: "policy_id" }),
		name: PG.text,
		description: PG.nullable(PG.text),
		resolution: PG.nullable(PG.text),
		critical: PG.bool,
		/** Comma-joined platforms the policy runs on (`darwin,windows`); null for every platform. */
		platform: PG.nullable(PG.text),
		failingHostCount: PG.column(PG.int4, { name: "failing_host_count" }),
		passingHostCount: PG.column(PG.int4, { name: "passing_host_count" }),
		failingHosts: PG.column(PG.jsonb(Schema.Array(FleetFindingHost)), { name: "failing_hosts" }),
		/** When Fleet last counted the policy's devices. */
		countedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "counted_at" }),
		firstSeenAt: PG.column(PG.timestamptzMillis, { name: "first_seen_at" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
	},
	primaryKey: ["orgId", "connectionId", "policyId"],
	foreignKeys: [
		PG.foreignKey({
			columns: ["orgId", "connectionId"],
			references: FleetConnections,
			foreignColumns: ["orgId", "id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type FleetPolicyFindingRow = PG.SelectRowOf<typeof FleetPolicyFindings>

/** A vulnerable software version on a device, as Fleet lists it under a CVE. */
export const FleetVulnerableSoftware = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	source: Schema.NullOr(Schema.String),
	hostCount: Schema.Number,
	resolvedInVersion: Schema.NullOr(Schema.String),
})
export type FleetVulnerableSoftware = typeof FleetVulnerableSoftware.Type

/** A CVE on software installed on at least one device. Fleet Premium adds the scores. */
export const FleetVulnerabilityFindings = PG.table("fleet_vulnerability_findings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		connectionId: PG.column(PG.text, { name: "connection_id" }),
		cve: PG.text,
		cvssScore: PG.column(PG.nullable(PG.float8), { name: "cvss_score" }),
		epssProbability: PG.column(PG.nullable(PG.float8), { name: "epss_probability" }),
		/** On CISA's known exploited list; null when the server does not say (Fleet Free). */
		knownExploited: PG.column(PG.nullable(PG.bool), { name: "known_exploited" }),
		detailsLink: PG.column(PG.nullable(PG.text), { name: "details_link" }),
		/** Devices with any affected version, summed across versions: a device with two counts twice. */
		hostCount: PG.column(PG.int4, { name: "host_count" }),
		software: PG.jsonb(Schema.Array(FleetVulnerableSoftware)),
		firstSeenAt: PG.column(PG.timestamptzMillis, { name: "first_seen_at" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
	},
	primaryKey: ["orgId", "connectionId", "cve"],
	foreignKeys: [
		PG.foreignKey({
			columns: ["orgId", "connectionId"],
			references: FleetConnections,
			foreignColumns: ["orgId", "id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type FleetVulnerabilityFindingRow = PG.SelectRowOf<typeof FleetVulnerabilityFindings>
