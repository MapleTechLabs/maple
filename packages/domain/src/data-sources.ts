import { Schema } from "effect"
import { ExternalDataSourceId } from "@maple/primitives"
import { MAX_RAW_SQL_LENGTH } from "./raw-sql"

// External data sources: systems an org connects so Maple can query them in place (a database
// or an API). Nothing is imported. Every driver answers with the same table (columns + rows),
// which is what lets one display pipeline, one alert evaluator and one agent tool serve them all.
// Plan: docs/external-data-sources-plan.md.

export { ExternalDataSourceId }

export const DATA_SOURCE_KINDS = ["clickhouse", "clerk"] as const
export const DataSourceKind = Schema.Literals(DATA_SOURCE_KINDS).annotate({
	identifier: "@maple/DataSourceKind",
})
export type DataSourceKind = Schema.Schema.Type<typeof DataSourceKind>

/** What a source accepts: SQL in one dialect, or a structured resource query (API sources). */
export const QueryLanguage = Schema.Literals(["sql:clickhouse", "resource"]).annotate({
	identifier: "@maple/DataSourceQueryLanguage",
})
export type QueryLanguage = Schema.Schema.Type<typeof QueryLanguage>

export const QUERY_LANGUAGE_BY_KIND = {
	clickhouse: "sql:clickhouse",
	clerk: "resource",
} as const satisfies Record<DataSourceKind, QueryLanguage>

export const DataSourceEnvironment = Schema.Literals(["production", "staging", "development", "other"])
export type DataSourceEnvironment = Schema.Schema.Type<typeof DataSourceEnvironment>

export const DataSourceStatus = Schema.Literals(["unknown", "ok", "error"])
export type DataSourceStatus = Schema.Schema.Type<typeof DataSourceStatus>

/** What tools take and models write: `shop-prod`, `clerk-prod`. */
export const DataSourceName = Schema.String.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/, {
		message: "Use 1 to 63 lowercase letters, digits or dashes, starting with a letter or digit",
	}),
)
export type DataSourceName = Schema.Schema.Type<typeof DataSourceName>

export const DataSourceDescription = Schema.String.check(Schema.isMaxLength(500))
export const DataSourceTag = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))
export const DataSourceTags = Schema.Array(DataSourceTag).check(Schema.isMaxLength(10))

// ── Stored, non-secret connection config (per kind) ─────────────────────────

export const ClickHouseDataSourceConfig = Schema.TaggedStruct("clickhouse", {
	url: Schema.String.check(Schema.isMaxLength(2048)),
	user: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
	database: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
})
export type ClickHouseDataSourceConfig = Schema.Schema.Type<typeof ClickHouseDataSourceConfig>

/** The Clerk instance type comes from the key: `sk_live_` is production, `sk_test_` development. */
export const ClerkDataSourceConfig = Schema.TaggedStruct("clerk", {
	instance: Schema.Literals(["production", "development"]),
})
export type ClerkDataSourceConfig = Schema.Schema.Type<typeof ClerkDataSourceConfig>

export const DataSourceConfig = Schema.Union([ClickHouseDataSourceConfig, ClerkDataSourceConfig])
export type DataSourceConfig = Schema.Schema.Type<typeof DataSourceConfig>

// ── Connection input (config + secret, as a form or an API call sends it) ───

export const ClickHouseConnectionInput = Schema.TaggedStruct("clickhouse", {
	url: Schema.String.check(Schema.isMaxLength(2048)),
	user: Schema.String.check(Schema.isMaxLength(256)),
	database: Schema.String.check(Schema.isMaxLength(256)),
	/** Omitted on update keeps the stored password. */
	password: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
})
export const ClerkConnectionInput = Schema.TaggedStruct("clerk", {
	/** Omitted on update keeps the stored key. */
	secretKey: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
})
export const DataSourceConnectionInput = Schema.Union([ClickHouseConnectionInput, ClerkConnectionInput])
export type DataSourceConnectionInput = Schema.Schema.Type<typeof DataSourceConnectionInput>

// ── Queries ────────────────────────────────────────────────────────────────

export const SqlExternalQuery = Schema.TaggedStruct("sql", {
	sql: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_RAW_SQL_LENGTH)),
})
export type SqlExternalQuery = Schema.Schema.Type<typeof SqlExternalQuery>

export const ResourceFilterOp = Schema.Literals([
	"eq",
	"neq",
	"in",
	"contains",
	"gt",
	"gte",
	"lt",
	"lte",
	/** Binds the field to the dashboard or alert time window; takes no value. */
	"within_window",
])
export type ResourceFilterOp = Schema.Schema.Type<typeof ResourceFilterOp>

export const ResourceScalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
export type ResourceScalar = Schema.Schema.Type<typeof ResourceScalar>

export const ResourceFilter = Schema.Struct({
	field: Schema.String,
	op: ResourceFilterOp,
	value: Schema.optionalKey(Schema.Union([ResourceScalar, Schema.Array(ResourceScalar)])),
})
export type ResourceFilter = Schema.Schema.Type<typeof ResourceFilter>

export const ResourceMeasure = Schema.Struct({
	fn: Schema.Literals(["count", "count_distinct", "sum", "avg", "min", "max"]),
	/** Required for every fn but `count`. */
	field: Schema.optionalKey(Schema.String),
})
export type ResourceMeasure = Schema.Schema.Type<typeof ResourceMeasure>

export const ResourceGroupBy = Schema.Struct({
	/** A timestamp field, bucketed by the query's granularity. */
	time: Schema.optionalKey(Schema.String),
	/** One categorical field. */
	field: Schema.optionalKey(Schema.String),
})
export type ResourceGroupBy = Schema.Schema.Type<typeof ResourceGroupBy>

export const ResourceOrderBy = Schema.Struct({
	field: Schema.String,
	dir: Schema.Literals(["asc", "desc"]),
})

export const MAX_RESOURCE_LIST_LIMIT = 1_000

/** A structured query over an API source's declared resources. No `measure` means list mode. */
export const ResourceExternalQuery = Schema.TaggedStruct("resource", {
	resource: Schema.String,
	measure: Schema.optionalKey(ResourceMeasure),
	filters: Schema.optionalKey(Schema.Array(ResourceFilter).check(Schema.isMaxLength(20))),
	groupBy: Schema.optionalKey(ResourceGroupBy),
	select: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(50))),
	orderBy: Schema.optionalKey(ResourceOrderBy),
	limit: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isBetween({ minimum: 1, maximum: MAX_RESOURCE_LIST_LIMIT }),
		),
	),
})
export type ResourceExternalQuery = Schema.Schema.Type<typeof ResourceExternalQuery>

export const ExternalQuery = Schema.Union([SqlExternalQuery, ResourceExternalQuery]).annotate({
	identifier: "@maple/ExternalQuery",
})
export type ExternalQuery = Schema.Schema.Type<typeof ExternalQuery>

// ── Catalog ────────────────────────────────────────────────────────────────

export const CatalogFieldType = Schema.Literals([
	"string",
	"number",
	"boolean",
	"timestamp",
	"json",
	"unknown",
])
export type CatalogFieldType = Schema.Schema.Type<typeof CatalogFieldType>

/** What an API field supports. `server` filters are pushed into the API call; `client` ones are applied after fetching. */
export const CatalogFieldCapabilities = Schema.Struct({
	filter: Schema.Literals(["server", "client", "none"]),
	sort: Schema.Boolean,
	group: Schema.Boolean,
	measure: Schema.Boolean,
})
export type CatalogFieldCapabilities = Schema.Schema.Type<typeof CatalogFieldCapabilities>

export const CatalogField = Schema.Struct({
	name: Schema.String,
	type: CatalogFieldType,
	/** The source's own type name (`DateTime64(9)`, `timestamptz`). */
	nativeType: Schema.optionalKey(Schema.String),
	note: Schema.optionalKey(Schema.String),
	pii: Schema.optionalKey(Schema.Boolean),
	capabilities: Schema.optionalKey(CatalogFieldCapabilities),
	sampleValues: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type CatalogField = Schema.Schema.Type<typeof CatalogField>

export const CatalogEntryKind = Schema.Literals(["table", "view", "resource"])
export type CatalogEntryKind = Schema.Schema.Type<typeof CatalogEntryKind>

export const CatalogEntry = Schema.Struct({
	/** `database.table` for SQL sources, the resource name for API sources. */
	name: Schema.String,
	kind: CatalogEntryKind,
	note: Schema.optionalKey(Schema.String),
	rowEstimate: Schema.optionalKey(Schema.Number),
	/** The field time windows and time groups use when a query names none. */
	timeField: Schema.optionalKey(Schema.String),
	fields: Schema.Array(CatalogField),
})
export type CatalogEntry = Schema.Schema.Type<typeof CatalogEntry>

export const CatalogExample = Schema.Struct({
	title: Schema.String,
	query: ExternalQuery,
})
export type CatalogExample = Schema.Schema.Type<typeof CatalogExample>

/** What a driver reports about a source: its tables or resources, and worked examples. */
export interface SourceCatalog {
	readonly entries: ReadonlyArray<CatalogEntry>
	readonly examples: ReadonlyArray<CatalogExample>
	/** True when the source had more entries than Maple stores. */
	readonly truncated: boolean
}

// ── Plans and results ──────────────────────────────────────────────────────

/** What a query will cost, known before anything runs. */
export const QueryPlanSummary = Schema.Union([
	Schema.TaggedStruct("sql", {
		/** The SQL with macros expanded, as it will be sent. */
		sql: Schema.String,
	}),
	Schema.TaggedStruct("resource", {
		strategy: Schema.Literals(["count", "scan"]),
		/** Upper bound on API calls. */
		calls: Schema.Number,
		/** Upper bound on rows read from the API (0 for count plans). */
		maxRows: Schema.Number,
		description: Schema.String,
	}),
])
export type QueryPlanSummary = Schema.Schema.Type<typeof QueryPlanSummary>

export const DataSourceColumn = Schema.Struct({
	name: Schema.String,
	type: CatalogFieldType,
})
export type DataSourceColumn = Schema.Schema.Type<typeof DataSourceColumn>

export const DataSourceTable = Schema.Struct({
	columns: Schema.Array(DataSourceColumn),
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	/** True when the row cap cut the result. */
	truncated: Schema.Boolean,
})
export type DataSourceTable = Schema.Schema.Type<typeof DataSourceTable>

export const DataSourceQueryResult = Schema.Struct({
	...DataSourceTable.fields,
	language: QueryLanguage,
	plan: QueryPlanSummary,
	/** Present for `explain` runs, which plan without executing. */
	executed: Schema.Boolean,
})
export type DataSourceQueryResult = Schema.Schema.Type<typeof DataSourceQueryResult>

export const DataSourceTestResult = Schema.Struct({
	ok: Schema.Boolean,
	latencyMs: Schema.Number,
	/** Non-fatal findings, e.g. the credentials can write. */
	warnings: Schema.Array(Schema.String),
	error: Schema.optionalKey(Schema.String),
})
export type DataSourceTestResult = Schema.Schema.Type<typeof DataSourceTestResult>

// ── Errors ─────────────────────────────────────────────────────────────────

/** No source by that id or name in this org (or it is hidden from agents). */
export class DataSourceNotFoundError extends Schema.TaggedError<DataSourceNotFoundError>()(
	"@maple/data-sources/NotFound",
	{
		message: Schema.String,
		rawRef: Schema.String,
		/** Closest existing names, for a "did you mean". */
		suggestions: Schema.Array(Schema.String),
	},
) {}

/** The input is wrong before anything reached the source: bad config, a query the source cannot take. */
export class DataSourceValidationError extends Schema.TaggedError<DataSourceValidationError>()(
	"@maple/data-sources/Validation",
	{
		message: Schema.String,
		field: Schema.optionalKey(Schema.String),
	},
) {}

/** Maple could not reach or authenticate with the source. */
export class DataSourceConnectionError extends Schema.TaggedError<DataSourceConnectionError>()(
	"@maple/data-sources/Connection",
	{
		message: Schema.String,
		reason: Schema.Literals(["network", "tls", "auth", "refused", "config"]),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** The source rejected the query; `message` is the source's own text. */
export class DataSourceQueryError extends Schema.TaggedError<DataSourceQueryError>()(
	"@maple/data-sources/Query",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export class DataSourceTimeoutError extends Schema.TaggedError<DataSourceTimeoutError>()(
	"@maple/data-sources/Timeout",
	{
		message: Schema.String,
		timeoutMs: Schema.Number,
	},
) {}

/** The query would exceed a row, byte, call or scan budget; refused before or while running. */
export class DataSourceLimitError extends Schema.TaggedError<DataSourceLimitError>()(
	"@maple/data-sources/Limit",
	{
		message: Schema.String,
	},
) {}

/** Maple's share of the source's rate limit is used up, or the source answered 429. */
export class DataSourceRateLimitedError extends Schema.TaggedError<DataSourceRateLimitedError>()(
	"@maple/data-sources/RateLimited",
	{
		message: Schema.String,
		retryAfterSeconds: Schema.optionalKey(Schema.Number),
	},
) {}

/** Maple's own storage (Postgres, encryption) failed. */
export class DataSourcePersistenceError extends Schema.TaggedError<DataSourcePersistenceError>()(
	"@maple/data-sources/Persistence",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** What a driver can fail with. */
export type DataSourceDriverError =
	| DataSourceValidationError
	| DataSourceConnectionError
	| DataSourceQueryError
	| DataSourceTimeoutError
	| DataSourceLimitError
	| DataSourceRateLimitedError

// ── Documents and inputs ───────────────────────────────────────────────────

/** A source as every API and tool shows it. Secrets never appear; `secretHint` is the last 4 characters. */
export const ExternalDataSourceDocument = Schema.Struct({
	id: ExternalDataSourceId,
	name: Schema.String,
	kind: DataSourceKind,
	queryLanguage: QueryLanguage,
	description: Schema.String,
	environment: DataSourceEnvironment,
	tags: Schema.Array(Schema.String),
	agentAccess: Schema.Boolean,
	agentPii: Schema.Boolean,
	config: DataSourceConfig,
	secretHint: Schema.NullOr(Schema.String),
	status: DataSourceStatus,
	lastCheckedAt: Schema.NullOr(Schema.Number),
	lastError: Schema.NullOr(Schema.String),
	catalogRefreshedAt: Schema.NullOr(Schema.Number),
	catalogEntryCount: Schema.Number,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
})
export type ExternalDataSourceDocument = Schema.Schema.Type<typeof ExternalDataSourceDocument>

export const CreateExternalDataSourceInput = Schema.Struct({
	name: DataSourceName,
	description: DataSourceDescription,
	environment: DataSourceEnvironment,
	tags: Schema.optionalKey(DataSourceTags),
	agentAccess: Schema.optionalKey(Schema.Boolean),
	agentPii: Schema.optionalKey(Schema.Boolean),
	connection: DataSourceConnectionInput,
})
export type CreateExternalDataSourceInput = Schema.Schema.Type<typeof CreateExternalDataSourceInput>

/** Every key optional; `connection` must keep the source's kind. */
export const UpdateExternalDataSourceInput = Schema.Struct({
	name: Schema.optionalKey(DataSourceName),
	description: Schema.optionalKey(DataSourceDescription),
	environment: Schema.optionalKey(DataSourceEnvironment),
	tags: Schema.optionalKey(DataSourceTags),
	agentAccess: Schema.optionalKey(Schema.Boolean),
	agentPii: Schema.optionalKey(Schema.Boolean),
	connection: Schema.optionalKey(DataSourceConnectionInput),
})
export type UpdateExternalDataSourceInput = Schema.Schema.Type<typeof UpdateExternalDataSourceInput>

/** Admin curation of one catalog entry; survives catalog refreshes. */
export const UpdateCatalogEntryInput = Schema.Struct({
	exposed: Schema.optionalKey(Schema.Boolean),
	note: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))),
	timeField: Schema.optionalKey(Schema.NullOr(Schema.String)),
	fieldNotes: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(300))),
	),
})
export type UpdateCatalogEntryInput = Schema.Schema.Type<typeof UpdateCatalogEntryInput>

/** One catalog entry as `describe` and the UI show it, with admin curation applied. */
export const CatalogEntryView = Schema.Struct({
	...CatalogEntry.fields,
	exposed: Schema.Boolean,
})
export type CatalogEntryView = Schema.Schema.Type<typeof CatalogEntryView>

/** A `search` hit: where data matching the words lives. */
export const DataSourceSearchHit = Schema.Struct({
	source: Schema.String,
	sourceId: ExternalDataSourceId,
	environment: DataSourceEnvironment,
	queryLanguage: QueryLanguage,
	entry: Schema.String,
	matchedFields: Schema.Array(Schema.String),
	reason: Schema.String,
	score: Schema.Number,
})
export type DataSourceSearchHit = Schema.Schema.Type<typeof DataSourceSearchHit>
