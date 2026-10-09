import * as PG from "@maple-dev/effect-orm/postgres"
import { DashboardId, DashboardVersionId, OrgId, UserId } from "@maple/domain/primitives"

export const Dashboards = PG.table("dashboards", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		id: PG.brand(PG.text, DashboardId),
		name: PG.text,
		payloadJson: PG.column(PG.jsonb(), { name: "payload_json" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		updatedBy: PG.column(PG.brand(PG.text, UserId), { name: "updated_by" }),
		// Optimistic-concurrency token. Bumped on every upsert; mutations use a
		// compare-and-swap on (id, version) and retry on conflict so concurrent
		// writers can no longer silently clobber each other.
		version: PG.column(PG.int4, { default: 0 }),
	},
	primaryKey: { columns: ["orgId", "id"], name: "dashboards_org_id_id_pk" },
	indexes: [
		PG.index("dashboards_org_updated_idx", ["orgId", "updatedAt"]),
		PG.index("dashboards_org_name_idx", ["orgId", "name"]),
	],
	tenantColumn: "orgId",
})

export type DashboardRow = PG.SelectRowOf<typeof Dashboards>
export type DashboardInsert = PG.InsertRowOf<typeof Dashboards>

/**
 * Append-only history of dashboard snapshots. One row per save, with
 * coalescing: back-to-back edits by the same actor of the same kind within
 * a short window update the latest row in place rather than appending.
 */
export const DashboardVersions = PG.table("dashboard_versions", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		id: PG.brand(PG.text, DashboardVersionId),
		dashboardId: PG.column(PG.brand(PG.text, DashboardId), { name: "dashboard_id" }),
		versionNumber: PG.column(PG.int4, { name: "version_number" }),
		snapshotJson: PG.column(PG.jsonb(), { name: "snapshot_json" }),
		changeKind: PG.column(PG.text, { name: "change_kind" }),
		changeSummary: PG.column(PG.nullable(PG.text), { name: "change_summary" }),
		sourceVersionId: PG.column(PG.nullable(PG.brand(PG.text, DashboardVersionId)), {
			name: "source_version_id",
		}),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
	},
	primaryKey: { columns: ["orgId", "id"], name: "dashboard_versions_org_id_id_pk" },
	indexes: [
		PG.index("dashboard_versions_org_dashboard_idx", ["orgId", "dashboardId", "versionNumber"]),
		// Prevents two concurrent saves from stamping the same version_number for
		// the same dashboard. Insert collisions surface as a unique-constraint
		// error which the persistence layer maps to a concurrency conflict.
		PG.uniqueIndex("dashboard_versions_org_dashboard_version_unq", [
			"orgId",
			"dashboardId",
			"versionNumber",
		]),
	],
	tenantColumn: "orgId",
})

export type DashboardVersionRow = PG.SelectRowOf<typeof DashboardVersions>
export type DashboardVersionInsert = PG.InsertRowOf<typeof DashboardVersions>
