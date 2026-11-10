import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/domain/primitives"

/**
 * Per-org AI auto-triage policy. Disabled by default, so an admin must opt in.
 */
export const AiTriageSettings = PG.table("ai_triage_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		enabled: PG.column(PG.bool, { default: false }),
		maxRunsPerDay: PG.column(PG.int4, { name: "max_runs_per_day", default: 20 }),
		/**
		 * Daily budget in *model passes*, which is what actually costs money. A second
		 * column rather than a reinterpretation of `maxRunsPerDay`, which is user-visible:
		 * changing its unit from runs to passes would silently shrink a configured limit.
		 */
		maxPassesPerDay: PG.column(PG.int4, { name: "max_passes_per_day", default: 90 }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "updated_by" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type AiTriageSettingsRow = PG.SelectRowOf<typeof AiTriageSettings>
