import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertRuleId, OrgId, SloId, SloWindowDays, UserId } from "@maple/domain/primitives"
import { SloSli } from "@maple/domain/slo"
import { Schema } from "effect"

/**
 * A service level objective over one service's entry-point spans. `alert_rule_id` is the
 * hidden `slo_burn_rate` alert rule that pages on fast budget burn (one per SLO).
 */
export const Slos = PG.table("slos", {
	columns: {
		id: PG.brand(PG.text, SloId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		description: PG.nullable(PG.text),
		serviceName: PG.column(PG.text, { name: "service_name" }),
		/** Deployment environments counted; empty counts every environment. */
		environmentsJson: PG.column(PG.jsonb(Schema.Array(Schema.String)), { name: "environments_json" }),
		sliJson: PG.column(PG.jsonb(SloSli), { name: "sli_json" }),
		targetPercent: PG.column(PG.float8, { name: "target_percent" }),
		windowDays: PG.column(PG.brand(PG.int4, SloWindowDays), { name: "window_days" }),
		alertRuleId: PG.column(PG.nullable(PG.brand(PG.text, AlertRuleId)), { name: "alert_rule_id" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		updatedBy: PG.column(PG.brand(PG.text, UserId), { name: "updated_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("slos_org_idx", ["orgId"]), PG.uniqueIndex("slos_org_name_unq", ["orgId", "name"])],
	tenantColumn: "orgId",
})

export type SloRow = PG.SelectRowOf<typeof Slos>
export type SloInsert = PG.InsertRowOf<typeof Slos>
