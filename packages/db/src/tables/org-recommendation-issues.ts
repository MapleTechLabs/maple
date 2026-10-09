import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

// Durable, numbered attribute-recommendation issues (PlanetScale-style). Recommendations are
// detected from live telemetry on each reconcile and upserted here, so each gets a stable per-org
// number, an opened-at timestamp, and a lifecycle status that survives across sessions/devices.
//
// status:
//   open      : detected and not acted on
//   dismissed : user dismissed it (reopenable)
//   applied   : user created the mapping; the key is no longer detected
//   resolved  : no longer detected (fixed at the SDK), and no mapping covers it
export const OrgRecommendationIssues = PG.table("org_recommendation_issues", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** Per-org monotonic display number (`#1`, `#2`, …). */
		number: PG.int4,
		/** Stable dedupe key from the detector, e.g. `rename:http.status_code`. */
		recommendationKey: PG.column(PG.text, { name: "recommendation_key" }),
		kind: PG.text,
		sourceKey: PG.column(PG.text, { name: "source_key" }),
		canonicalKey: PG.column(PG.nullable(PG.text), { name: "canonical_key" }),
		status: PG.column(PG.text, { default: "open" }),
		usageCount: PG.column(PG.int4, { name: "usage_count", default: 0 }),
		openedAt: PG.column(PG.timestamptzMillis, { name: "opened_at", defaultExpr: "now()" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at", defaultExpr: "now()" }),
		resolvedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "resolved_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("org_recommendation_issues_org_idx", ["orgId"]),
		PG.uniqueIndex("org_recommendation_issues_org_key_idx", ["orgId", "recommendationKey"]),
	],
	tenantColumn: "orgId",
})

export type OrgRecommendationIssueRow = PG.SelectRowOf<typeof OrgRecommendationIssues>
export type OrgRecommendationIssueInsert = PG.InsertRowOf<typeof OrgRecommendationIssues>
