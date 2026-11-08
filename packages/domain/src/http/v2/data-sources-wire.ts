import { Schema } from "effect"
import {
	CatalogEntryKind,
	CatalogFieldType,
	DataSourceDescription,
	DataSourceEnvironment,
	DataSourceKind,
	DataSourceName,
	DataSourceStatus,
	DataSourceTags,
	ExternalDataSourceId,
	QueryLanguage,
} from "../../data-sources"
import { wireExample, Timestamp } from "./envelopes"
import { PublicId, PublicIdPrefixes } from "./public-id"

// Wire shapes for `/v2/data_sources`: snake_case, ISO timestamps, secrets never present.

/** `dsrc_…` public ID ⇄ internal `ExternalDataSourceId` (raw UUID). */
export const DataSourcePublicId = PublicId(PublicIdPrefixes.dataSource, ExternalDataSourceId)

export const V2ClickHouseConnection = Schema.Struct({
	type: Schema.Literal("clickhouse"),
	url: Schema.String.annotate({ description: "HTTPS URL of the ClickHouse HTTP interface." }),
	user: Schema.String,
	database: Schema.String,
}).annotate({ identifier: "DataSourceClickHouseConnection" })

export const V2ClerkConnection = Schema.Struct({
	type: Schema.Literal("clerk"),
	instance: Schema.Literals(["production", "development"]).annotate({
		description: "Read from the secret key: `sk_live_` is production, `sk_test_` development.",
	}),
}).annotate({ identifier: "DataSourceClerkConnection" })

export const V2DataSourceConnection = Schema.Union([V2ClickHouseConnection, V2ClerkConnection])
export type V2DataSourceConnection = Schema.Schema.Type<typeof V2DataSourceConnection>

export const V2DataSource = Schema.Struct({
	id: DataSourcePublicId,
	object: Schema.Literal("data_source"),
	name: Schema.String.annotate({ description: "The slug tools and agents use, e.g. `shop-prod`." }),
	kind: DataSourceKind,
	query_language: QueryLanguage,
	description: Schema.String.annotate({
		description: "What the source holds. Assistants read it to pick the right source.",
	}),
	environment: DataSourceEnvironment,
	tags: Schema.Array(Schema.String),
	agent_access: Schema.Boolean.annotate({ description: "Whether agents and MCP tools may query it." }),
	agent_pii: Schema.Boolean.annotate({
		description: "Whether agents may read fields marked personal data.",
	}),
	connection: V2DataSourceConnection,
	secret_hint: Schema.NullOr(Schema.String).annotate({
		description: "Last 4 characters of the stored password or key; the secret itself is never returned.",
	}),
	status: DataSourceStatus,
	last_checked_at: Schema.NullOr(Timestamp),
	last_error: Schema.NullOr(Schema.String),
	catalog_refreshed_at: Schema.NullOr(Timestamp),
	catalog_error: Schema.NullOr(Schema.String),
	catalog_entry_count: Schema.Number,
	created_at: Timestamp,
	updated_at: Timestamp,
}).annotate({
	identifier: "DataSource",
	title: "Data Source",
	description:
		"A database or API your organization connected so Maple can query it in place. Nothing is imported.",
	examples: [
		wireExample({
			id: "dsrc_YofPTrK9782DWwcnXhpcCw",
			object: "data_source",
			name: "shop-prod",
			kind: "clickhouse",
			query_language: "sql:clickhouse",
			description: "Production storefront database: orders and payments",
			environment: "production",
			tags: ["shop"],
			agent_access: true,
			agent_pii: false,
			connection: {
				type: "clickhouse",
				url: "https://ch.example.com:8443",
				user: "reader",
				database: "shop",
			},
			secret_hint: "x9Qa",
			status: "ok",
			last_checked_at: "2026-11-08T12:00:00.000Z",
			last_error: null,
			catalog_refreshed_at: "2026-11-08T12:00:01.000Z",
			catalog_error: null,
			catalog_entry_count: 12,
			created_at: "2026-11-08T12:00:00.000Z",
			updated_at: "2026-11-08T12:00:00.000Z",
		}),
	],
})
export type V2DataSource = Schema.Schema.Type<typeof V2DataSource>

/** A source as `create` and `update` return it, with what its connection test warned about. */
export const V2SavedDataSource = Schema.Struct({
	...V2DataSource.fields,
	warnings: Schema.Array(Schema.String).annotate({
		description:
			"Non-fatal findings from the connection test, e.g. the user can write. Empty when the connection did not change.",
	}),
}).annotate({ identifier: "SavedDataSource", title: "Saved Data Source" })
export type V2SavedDataSource = Schema.Schema.Type<typeof V2SavedDataSource>

const Password = Schema.String.check(Schema.isMaxLength(1024))
const SecretKey = Schema.String.check(Schema.isMaxLength(512))

export const V2DataSourceConnectionParams = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("clickhouse"),
		url: Schema.String.check(Schema.isMaxLength(2048)),
		user: Schema.String.check(Schema.isMaxLength(256)),
		database: Schema.String.check(Schema.isMaxLength(256)),
		password: Schema.optionalKey(
			Password.annotate({ description: "Omit on update to keep the stored one." }),
		),
	}),
	Schema.Struct({
		type: Schema.Literal("clerk"),
		secret_key: Schema.optionalKey(
			SecretKey.annotate({ description: "Omit on update to keep the stored one." }),
		),
	}),
]).annotate({ identifier: "DataSourceConnectionParams" })
export type V2DataSourceConnectionParams = Schema.Schema.Type<typeof V2DataSourceConnectionParams>

export const V2DataSourceCreateParams = Schema.Struct({
	name: DataSourceName,
	description: DataSourceDescription.check(Schema.isMinLength(1)),
	environment: DataSourceEnvironment,
	tags: Schema.optionalKey(DataSourceTags),
	agent_access: Schema.optionalKey(Schema.Boolean),
	agent_pii: Schema.optionalKey(Schema.Boolean),
	connection: V2DataSourceConnectionParams,
}).annotate({ identifier: "DataSourceCreateParams", title: "Data source create parameters" })
export type V2DataSourceCreateParams = Schema.Schema.Type<typeof V2DataSourceCreateParams>

export const V2DataSourceUpdateParams = Schema.Struct({
	name: Schema.optionalKey(DataSourceName),
	description: Schema.optionalKey(DataSourceDescription.check(Schema.isMinLength(1))),
	environment: Schema.optionalKey(DataSourceEnvironment),
	tags: Schema.optionalKey(DataSourceTags),
	agent_access: Schema.optionalKey(Schema.Boolean),
	agent_pii: Schema.optionalKey(Schema.Boolean),
	connection: Schema.optionalKey(V2DataSourceConnectionParams),
}).annotate({ identifier: "DataSourceUpdateParams", title: "Data source update parameters" })
export type V2DataSourceUpdateParams = Schema.Schema.Type<typeof V2DataSourceUpdateParams>

export const V2DataSourceDeleteResponse = Schema.Struct({
	id: DataSourcePublicId,
	object: Schema.Literal("data_source"),
	deleted: Schema.Literal(true),
}).annotate({ identifier: "DataSourceDeleteResponse" })
export type V2DataSourceDeleteResponse = Schema.Schema.Type<typeof V2DataSourceDeleteResponse>

export const V2DataSourceTestResult = Schema.Struct({
	object: Schema.Literal("data_source_test"),
	ok: Schema.Boolean,
	latency_ms: Schema.Number,
	warnings: Schema.Array(Schema.String).annotate({
		description: "Non-fatal findings, e.g. the user can write.",
	}),
	error: Schema.NullOr(Schema.String).annotate({
		description: "What the source said when the test failed.",
	}),
}).annotate({ identifier: "DataSourceTestResult" })
export type V2DataSourceTestResult = Schema.Schema.Type<typeof V2DataSourceTestResult>

export const V2CatalogField = Schema.Struct({
	name: Schema.String,
	type: CatalogFieldType,
	native_type: Schema.NullOr(Schema.String),
	note: Schema.NullOr(Schema.String),
	pii: Schema.Boolean,
	sample_values: Schema.Array(Schema.String).annotate({
		description: "Values seen in the field, for low-cardinality enums such as a status.",
	}),
})
export type V2CatalogField = Schema.Schema.Type<typeof V2CatalogField>

export const V2CatalogEntry = Schema.Struct({
	object: Schema.Literal("data_source_catalog_entry"),
	name: Schema.String.annotate({
		description: "`database.table` for SQL sources, the resource name for APIs.",
	}),
	kind: CatalogEntryKind,
	exposed: Schema.Boolean.annotate({ description: "Whether agents see this entry." }),
	note: Schema.NullOr(Schema.String),
	row_estimate: Schema.NullOr(Schema.Number),
	time_field: Schema.NullOr(Schema.String),
	fields: Schema.Array(V2CatalogField),
}).annotate({ identifier: "DataSourceCatalogEntry" })
export type V2CatalogEntry = Schema.Schema.Type<typeof V2CatalogEntry>

export const V2DataSourceCatalog = Schema.Struct({
	object: Schema.Literal("data_source_catalog"),
	source_id: DataSourcePublicId,
	refreshed_at: Schema.NullOr(Timestamp),
	error: Schema.NullOr(Schema.String),
	entries: Schema.Array(V2CatalogEntry),
}).annotate({ identifier: "DataSourceCatalog" })
export type V2DataSourceCatalog = Schema.Schema.Type<typeof V2DataSourceCatalog>

export const V2CatalogEntryUpdateParams = Schema.Struct({
	exposed: Schema.optionalKey(Schema.Boolean),
	note: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))),
	time_field: Schema.optionalKey(Schema.NullOr(Schema.String)),
	field_notes: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(300))).annotate({
			description: "Replaces every field note on the entry.",
		}),
	),
}).annotate({ identifier: "DataSourceCatalogEntryUpdateParams" })
export type V2CatalogEntryUpdateParams = Schema.Schema.Type<typeof V2CatalogEntryUpdateParams>
