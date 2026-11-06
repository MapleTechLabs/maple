import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/domain/primitives"

/**
 * Per-org AI auto-triage policy. Disabled by default, so an admin must opt in.
 * Triage runs on Maple's managed AI (Cloudflare Workers AI via the api worker's
 * `AI` binding); no per-org model or key configuration is needed.
 */
export const AiTriageSettings = PG.table("ai_triage_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		enabled: PG.column(PG.bool, { default: false }),
		maxRunsPerDay: PG.column(PG.int4, { name: "max_runs_per_day", default: 20 }),
		/**
		 * Daily budget in *model passes*, which is what actually costs money: a
		 * five-lens fan-out is six passes inside one run.
		 *
		 * Deliberately a second column rather than a reinterpretation of
		 * `maxRunsPerDay`: that one is org-configurable and user-visible, and silently
		 * changing its unit from runs to passes would turn a configured 20 into about
		 * three critical incidents a day with no warning and no failing test.
		 *
		 * Default raised from 60 with the planner: an incident spends planner + up to
		 * 4 hypotheses + validator ≈ 6 passes, so 60 was about ten incidents a day and
		 * 90 is about fifteen.
		 */
		maxPassesPerDay: PG.column(PG.int4, { name: "max_passes_per_day", default: 90 }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "updated_by" }),
	},
	primaryKey: ["orgId"],
	tenantColumn: "orgId",
})

export type AiTriageSettingsRow = PG.SelectRowOf<typeof AiTriageSettings>
