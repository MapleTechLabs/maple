import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/domain/primitives"

export const OrgClickHouseSettings = PG.table("org_clickhouse_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		chUrl: PG.column(PG.text, { name: "ch_url" }),
		chUser: PG.column(PG.text, { name: "ch_user" }),
		chPasswordCiphertext: PG.column(PG.nullable(PG.text), { name: "ch_password_ciphertext" }),
		chPasswordIv: PG.column(PG.nullable(PG.text), { name: "ch_password_iv" }),
		chPasswordTag: PG.column(PG.nullable(PG.text), { name: "ch_password_tag" }),
		chDatabase: PG.column(PG.text, { name: "ch_database" }),
		// Connection-level health: "connected" once we've successfully talked to
		// the cluster, "error" if the most recent introspection or apply failed.
		// Schema drift is tracked separately by the diff endpoint.
		syncStatus: PG.column(PG.text, { name: "sync_status" }),
		lastSyncAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_sync_at" }),
		lastSyncError: PG.column(PG.nullable(PG.text), { name: "last_sync_error" }),
		// ClickHouse schema identity at the time of the last successful apply (or
		// null before first apply). Holds `clickHouseSchemaVersion` (the bundled
		// migration version, NOT the Tinybird-coupled `clickHouseProjectRevision`
		// hash) so the ingest gateway's readiness gate doesn't trip on unrelated
		// Tinybird schema changes. The ingest gateway compares against it.
		schemaVersion: PG.column(PG.nullable(PG.text), { name: "schema_version" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		createdBy: PG.column(PG.text, { name: "created_by" }),
		updatedBy: PG.column(PG.text, { name: "updated_by" }),
	},
	primaryKey: { columns: ["orgId"], name: "org_clickhouse_settings_org_id_pk" },
	tenantColumn: "orgId",
})

export type OrgClickHouseSettingsRow = PG.SelectRowOf<typeof OrgClickHouseSettings>
export type OrgClickHouseSettingsInsert = PG.InsertRowOf<typeof OrgClickHouseSettings>
