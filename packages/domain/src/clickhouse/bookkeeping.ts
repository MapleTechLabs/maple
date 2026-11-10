import { String as Str } from "effect"

/**
 * The tables a target ClickHouse records Maple's applied migrations and schema
 * features in, shared by the API's apply workflow and the airgapped CLI.
 */
export const SCHEMA_MIGRATIONS_TABLE = "_maple_schema_migrations"
export const SCHEMA_FEATURES_TABLE = "_maple_schema_features"

export const quoteClickHouseIdentifier = (name: string): string => `\`${Str.replaceAll("`", "``")(name)}\``

const quoteString = (value: string): string => `'${Str.replaceAll("'", "''")(value)}'`

const migrationsTable = quoteClickHouseIdentifier(SCHEMA_MIGRATIONS_TABLE)
const featuresTable = quoteClickHouseIdentifier(SCHEMA_FEATURES_TABLE)

export const createSchemaMigrationsTableSql = `CREATE TABLE IF NOT EXISTS ${migrationsTable} (version UInt32, applied_at DateTime64(3) DEFAULT now64(3), description String) ENGINE = MergeTree ORDER BY version`

export const createSchemaFeaturesTableSql = `CREATE TABLE IF NOT EXISTS ${featuresTable} (id String, revision UInt32, applied_at DateTime64(3) DEFAULT now64(3), description String) ENGINE = ReplacingMergeTree(revision) ORDER BY id`

export const selectAppliedVersionsSql = `SELECT version FROM ${migrationsTable} FORMAT JSONEachRow`

export const selectAppliedMigrationsSql = `SELECT version, applied_at, description FROM ${migrationsTable} ORDER BY version FORMAT JSONEachRow`

export const recordMigrationSql = (version: number, description: string): string =>
	`INSERT INTO ${migrationsTable} (version, description) VALUES (${version}, ${quoteString(description)})`

/** The newest applied revision per feature; the table is a ReplacingMergeTree, so `max` reads it before merges. */
export const selectFeatureRevisionsSql = `SELECT id, max(revision) AS revision FROM ${featuresTable} GROUP BY id FORMAT JSONEachRow`

export const recordFeatureSql = (id: string, revision: number, description: string): string =>
	`INSERT INTO ${featuresTable} (id, revision, description) VALUES (${quoteString(id)}, ${revision}, ${quoteString(description)})`
