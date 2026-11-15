import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/primitives"

// What Maple does in the org's Linear workspace, one switch per feature of the catalog's `linear`
// entry. A missing row does everything. Kept across a disconnect, like Cloudflare's switches.
export const LinearFeatureSettings = PG.table("linear_feature_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		openIssuesEnabled: PG.column(PG.bool, { name: "open_issues_enabled", default: true }),
		updateCommentsEnabled: PG.column(PG.bool, { name: "update_comments_enabled", default: true }),
		reopenIssuesEnabled: PG.column(PG.bool, { name: "reopen_issues_enabled", default: true }),
		resolveCommentsEnabled: PG.column(PG.bool, { name: "resolve_comments_enabled", default: true }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "updated_by" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type LinearFeatureSettingsRow = PG.SelectRowOf<typeof LinearFeatureSettings>
