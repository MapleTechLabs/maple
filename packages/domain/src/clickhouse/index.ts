export {
	emitCreateMaterializedView,
	emitCreateTable,
	emitJsonPathSpec,
	emitProjectDdl,
	extractColumnDefinition,
	parseEmittedStatement,
	type EmittedMaterializedView,
	type EmittedStatement,
	type EmittedTable,
	type EmittedTableColumn,
	type EmitterOptions,
	type EngineFlavor,
	type ResourceContent,
} from "./ddl-emitter"
export {
	migrations,
	latestMigrationVersion,
	clickHouseSchemaVersion,
	migrationFailureIsSkippable,
	type ClickHouseMigration,
	type MigrationStatement,
} from "./migrations"
export { performanceOnlySearchColumns } from "./migrations/0010_search_indexes"
export { sortingKeyMigrationColumns } from "./migrations/0076_retention_storage"
export {
	type DropUnkeyedColumnSpec,
	type RepairZeroKeyColumnSpec,
	isDropUnkeyedColumn,
	isRepairZeroKeyColumn,
} from "./unkeyed-column"
export {
	type BackfillSpec,
	isBackfill,
	renderBackfillFull,
	renderStatementFull,
	compileBackfillChunk,
} from "./backfill"
export { expandMigrationToSteps, expandBackfill, type ApplyStep, type ExecFn } from "./apply-plan"
export { qualifyStatementForDatabase } from "./qualify"
export * from "./bookkeeping"
export {
	computeSchemaDiff,
	type ColumnDrift,
	type DesiredSchema,
	type DesiredTable,
	type ActualTable,
	type TableDiffEntry,
} from "./diff"
export { projectRevision as clickHouseProjectRevision } from "../generated/clickhouse-schema"
export {
	clickHouseSchemaFeatures,
	clickHouseVersionAtLeast,
	featureSupportedByVersion,
	ClickHouseSchemaFeatureId,
	type ClickHouseSchemaFeature,
} from "./features"
