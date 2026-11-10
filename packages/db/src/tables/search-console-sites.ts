import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, SearchConsoleSiteId, SearchConsoleSiteUrl } from "@maple/primitives"
import { OAuthConnections } from "./oauth-connections"

// One row per Google Search Console property an org picked, under its Google OAuth grant
// (`oauth_connections`, provider "google"). Disconnecting drops the grant and these rows with it.
// The poll-state columns belong to the daily Search Analytics importer.
export const SearchConsoleSites = PG.table("search_console_sites", {
	columns: {
		id: PG.brand(PG.text, SearchConsoleSiteId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		oauthConnectionId: PG.column(PG.text, { name: "oauth_connection_id" }),
		// Google's own property id: `sc-domain:example.com` or a URL prefix (`https://example.com/`).
		siteUrl: PG.column(PG.brand(PG.text, SearchConsoleSiteUrl), { name: "site_url" }),
		// Google's permission on the property (siteOwner, siteFullUser, siteRestrictedUser, ...),
		// as of the last time the org saved its selection.
		permissionLevel: PG.column(PG.text, { name: "permission_level" }),
		// False when the customer turned the property off; the importer skips it, its state stays.
		enabled: PG.column(PG.bool, { default: true }),
		// HEAD frontier: the newest day (YYYY-MM-DD, Google's Pacific day) imported, often today and
		// partial. `completeThrough` (@maple/domain/search-console) is the last whole day. Null until the first import.
		watermarkDate: PG.column(PG.nullable(PG.text), { name: "watermark_date" }),
		// BACKFILL frontier: the oldest day (YYYY-MM-DD) history import has reached, walking DOWN
		// toward Google's 16-month limit. Null before the first import seeds it.
		backfillDate: PG.column(PG.nullable(PG.text), { name: "backfill_date" }),
		lastSyncedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_synced_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		// Overlap guard: a tick claims the row by moving this past now; a tick that fails to claim skips it.
		leaseUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "lease_until" }),
		// Backoff: the importer skips the row until then. Null when the last import succeeded.
		nextAttemptAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "next_attempt_at" }),
		// Failed imports since the last success; the importer's backoff doubles per failure.
		consecutiveFailures: PG.column(PG.int4, { name: "consecutive_failures", default: 0 }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("search_console_sites_org_site_idx", ["orgId", "siteUrl"]),
		PG.index("search_console_sites_connection_idx", ["oauthConnectionId"]),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["oauthConnectionId"],
			references: OAuthConnections,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type SearchConsoleSiteRow = PG.SelectRowOf<typeof SearchConsoleSites>
