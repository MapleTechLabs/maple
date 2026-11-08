import * as PG from "@maple-dev/effect-orm/postgres"
import {
	CatalogEntryKind,
	CatalogExample,
	CatalogField,
	DataSourceConfig,
	DataSourceEnvironment,
	DataSourceKind,
	DataSourceStatus,
	ExternalDataSourceId,
} from "@maple/domain/data-sources"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Schema } from "effect"

// A system an org connects so Maple can query it in place: a database or an API. Nothing is
// imported. Distinct from `sources`, which are things that send telemetry to Maple.
// Plan: docs/external-data-sources-plan.md.
export const ExternalDataSources = PG.table("external_data_sources", {
	columns: {
		id: PG.brand(PG.text, ExternalDataSourceId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		kind: PG.brand(PG.text, DataSourceKind),
		description: PG.text,
		environment: PG.brand(PG.text, DataSourceEnvironment),
		tags: PG.column(PG.jsonb(Schema.Array(Schema.String)), { defaultExpr: "'[]'::jsonb" }),
		// Hidden from every agent tool when false.
		agentAccess: PG.column(PG.bool, { name: "agent_access", default: true }),
		// Agents may read fields the catalog marks PII (emails, names).
		agentPii: PG.column(PG.bool, { name: "agent_pii", default: false }),
		config: PG.jsonb(DataSourceConfig),
		// AES-256-GCM, AAD bound to org and source id. Null when the source needs no secret.
		secretCiphertext: PG.column(PG.nullable(PG.text), { name: "secret_ciphertext" }),
		secretIv: PG.column(PG.nullable(PG.text), { name: "secret_iv" }),
		secretTag: PG.column(PG.nullable(PG.text), { name: "secret_tag" }),
		secretHint: PG.column(PG.nullable(PG.text), { name: "secret_hint" }),
		status: PG.brand(PG.text, DataSourceStatus),
		lastCheckedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_checked_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		catalogRefreshedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "catalog_refreshed_at" }),
		catalogError: PG.column(PG.nullable(PG.text), { name: "catalog_error" }),
		// Worked examples from the driver and the admin; they teach models the conventions.
		examples: PG.column(PG.jsonb(Schema.Array(CatalogExample)), { defaultExpr: "'[]'::jsonb" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		updatedBy: PG.column(PG.brand(PG.text, UserId), { name: "updated_by" }),
	},
	primaryKey: ["id"],
	indexes: [PG.uniqueIndex("external_data_sources_org_name_unique", ["orgId", "name"])],
	tenantColumn: "orgId",
})

export type ExternalDataSourceRow = PG.SelectRowOf<typeof ExternalDataSources>
export type ExternalDataSourceInsert = PG.InsertRowOf<typeof ExternalDataSources>

// One table, view or API resource of a source, captured from the source (or the driver) and
// curated by admins. A refresh rewrites `fields`, `kind`, `row_estimate` and the detected time
// field; `exposed`, `note`, `time_field_override` and `field_notes` are the admin's and survive it.
export const ExternalDataSourceCatalogEntries = PG.table("external_data_source_catalog_entries", {
	columns: {
		sourceId: PG.column(PG.brand(PG.text, ExternalDataSourceId), { name: "source_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		kind: PG.brand(PG.text, CatalogEntryKind),
		rowEstimate: PG.column(PG.nullable(PG.float8), { name: "row_estimate" }),
		// From the source or the driver.
		sourceNote: PG.column(PG.nullable(PG.text), { name: "source_note" }),
		detectedTimeField: PG.column(PG.nullable(PG.text), { name: "detected_time_field" }),
		fields: PG.jsonb(Schema.Array(CatalogField)),
		// Admin curation.
		exposed: PG.column(PG.bool, { default: true }),
		note: PG.nullable(PG.text),
		timeFieldOverride: PG.column(PG.nullable(PG.text), { name: "time_field_override" }),
		fieldNotes: PG.column(PG.jsonb(Schema.Record(Schema.String, Schema.String)), {
			name: "field_notes",
			defaultExpr: "'{}'::jsonb",
		}),
		// The refresh that last saw this entry; older entries are gone from the source.
		seenAt: PG.column(PG.timestamptzMillis, { name: "seen_at" }),
	},
	primaryKey: { columns: ["sourceId", "name"], name: "external_data_source_catalog_entries_pk" },
	indexes: [PG.index("external_data_source_catalog_entries_org_idx", ["orgId"])],
	foreignKeys: [
		PG.foreignKey({
			columns: ["sourceId"],
			references: ExternalDataSources,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type ExternalDataSourceCatalogEntryRow = PG.SelectRowOf<typeof ExternalDataSourceCatalogEntries>
export type ExternalDataSourceCatalogEntryInsert = PG.InsertRowOf<typeof ExternalDataSourceCatalogEntries>
