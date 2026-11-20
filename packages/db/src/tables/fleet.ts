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
		/** The device findings sync's own lease, hold and state: it runs apart from the activity poll. */
		findingsLeaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "findings_lease_until" }),
		findingsHoldUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "findings_hold_until" }),
		findingsSyncedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "findings_synced_at" }),
		findingsError: PG.column(PG.nullable(PG.text), { name: "findings_error" }),
		findingsErrorAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "findings_error_at" }),
		/** Enrolled devices at the last findings sync. */
		deviceCount: PG.column(PG.nullable(PG.int4), { name: "device_count" }),
		/** Every CVE Fleet counts on the server's devices at the last sync, past those stored too. */
		vulnerabilityCount: PG.column(PG.nullable(PG.int4), { name: "vulnerability_count" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("fleet_connections_org_idx", ["orgId"])],
	tenantColumn: "orgId",
})

export type FleetConnectionRow = PG.SelectRowOf<typeof FleetConnections>
