import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/primitives"

/**
 * The daily salt behind cookieless visitor ids (`persistence: "cookieless"` in the browser SDK).
 * The ingest gateway hashes it with the org, client IP and user agent, then deletes each salt after
 * two days so no stored id can be traced back to an IP. Shared so every gateway task agrees.
 */
export const CookielessSalts = PG.table("cookieless_salts", {
	columns: {
		/** UTC day, `YYYY-MM-DD`. */
		day: PG.text,
		/** 32 random bytes, base64. */
		salt: PG.text,
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at", defaultExpr: "now()" }),
	},
	primaryKey: ["day"],
})

/**
 * The billing visit claim for cookieless visitors, which the browser cannot keep: one row per
 * visitor id (already daily), extended by each session start. A start more than 30 idle minutes
 * after the last one is a new billable visit. The gateway deletes rows a day after their last start.
 */
export const CookielessVisits = PG.table("cookieless_visits", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		visitorId: PG.column(PG.text, { name: "visitor_id" }),
		/** Random per claim; the claim whose token is stored opened the visit, so it bills. */
		visitToken: PG.column(PG.text, { name: "visit_token" }),
		lastSeenAt: PG.column(PG.timestamptzMillis, { name: "last_seen_at" }),
	},
	primaryKey: ["orgId", "visitorId"],
	indexes: [PG.index("cookieless_visits_last_seen_idx", ["lastSeenAt"])],
	tenantColumn: "orgId",
})
