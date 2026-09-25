// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { resolve } from "node:path"
import { Schema } from "effect"
import {
	cloneStoreForStaging,
	decodeInstalledProgress,
	makeRawRowsState,
	type InstalledProgress,
	RAW_TABLES,
	rawRowCounts,
	expectedManifest,
	UnsignedDecimal,
} from "./journal-codecs"
import { readRawTelemetryRetentionDays } from "../chdb"
import type {
	LocalStoreMigrationModule,
	MigrationModuleContext,
	MigrationOperation,
	StateDispositionEntry,
} from "../local-store-migration-module"
import {
	LOCAL_SCHEMA_V22,
	LOCAL_SCHEMA_V22_MANIFEST,
	LOCAL_SCHEMA_V22_SQL,
	LOCAL_SCHEMA_V23,
	LOCAL_SCHEMA_V23_MANIFEST,
	LOCAL_SCHEMA_V23_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/**
 * The local mirror of ClickHouse migration 0033.
 *
 * `service_external_edges_hourly_mv` excluded database spans on
 * `db.system.name` alone while `service_map_db_edges_hourly_mv` selects them on
 * the `db.system.name` -> `db.system` coalesce, so a span carrying only the
 * legacy key landed in both rollups. v23 recreates the external view with the
 * same coalesce. No table changes, no row moves.
 *
 * A materialized view's SELECT is frozen at creation, so the v22 view is dropped
 * in a pre-bootstrap block or it survives the v23 bootstrap's `IF NOT EXISTS`.
 *
 * NOTHING IS BACKFILLED, as in 0033: hours sealed under v22 keep their phantom
 * external rows until the rollup's retention ages them out.
 *
 * Every statement is idempotent, so a resume after a crash lands in the same
 * place.
 */

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0022-to-0023-external-edges-legacy-db-system" as const

class RowCountMismatch extends Schema.TaggedError<RowCountMismatch>()("@maple/cli/RowCountMismatch", {
	message: Schema.String,
	moduleId: Schema.String,
	table: Schema.String,
	expected: UnsignedDecimal,
	actual: UnsignedDecimal,
}) {}

const V22ToV23StateCodec = makeRawRowsState(MODULE_ID)

type V22ToV23State = typeof V22ToV23StateCodec.schema.Type
type V22ToV23Progress = InstalledProgress

const decodeState = V22ToV23StateCodec.decode
const decodeProgress = decodeInstalledProgress

const preflight = async (context: MigrationModuleContext): Promise<V22ToV23State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V22_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V22_SQL, bootstrapSchema: false },
	)
	// Two literals rather than a conditional spread: `retentionDays` is an
	// `optionalKey`, so an absent floor has to be an absent key, not a present
	// `undefined`.
	return retentionDays === undefined
		? { module: MODULE_ID, version: 1, rawRows }
		: { module: MODULE_ID, version: 1, rawRows, retentionDays }
}

const prepareTarget = async (
	context: MigrationModuleContext,
	state: V22ToV23State,
): Promise<V22ToV23State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

const apply = async (context: MigrationModuleContext): Promise<V22ToV23Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("DROP VIEW IF EXISTS service_external_edges_hourly_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V22_SQL, bootstrapSchema: false },
	)
	// The v23 bootstrap recreates the view with its new SELECT; every other
	// object already exists and its `IF NOT EXISTS` is a no-op.
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V23_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V22ToV23State,
	_progress: V22ToV23Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V23_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new RowCountMismatch({
						message: `v22 -> v23 raw telemetry verification failed for ${table}`,
						moduleId: MODULE_ID,
						table,
						expected: state.rawRows[table] ?? "0",
						actual: targetRows[table] ?? "0",
					})
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V23_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v22-store",
		description: "Clone the stopped v22 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "recreate-external-edges-view",
		description:
			"Rebuild service_external_edges_hourly_mv so spans with only the legacy db.system attribute are excluded",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v23-schema",
		description: "Verify the v23 physical schema and the retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v22 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the replaced view is neither read nor rewritten; only the view definition changes.",
	},
	{
		// Existing rows are kept as-is, including hours that counted a legacy
		// db.system span as an external edge. Forward-only, the same gap the
		// managed side accepts.
		name: "service_external_edges_hourly",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched; the rebuilt view stops writing legacy db.system spans for spans materialized after the migration and older hours age out with the rollup's retention.",
		preservationInterval: "from the migration forward",
		sourceRetentionDays: 30,
		targetRetentionDays: 365,
	},
]

export const v22ToV23ExternalEdgesLegacyDbSystemModule: LocalStoreMigrationModule<
	V22ToV23State,
	V22ToV23Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Rebuild service_external_edges_hourly_mv so a span with only the legacy db.system attribute is a database edge, never also an external one",
	from: LOCAL_SCHEMA_V22,
	to: LOCAL_SCHEMA_V23,
	operations,
	dispositions,
	decodeState,
	decodeProgress,
	preflight,
	prepareTarget,
	apply,
	verify,
	recover: async (_context, state, progress) => ({ state, progress }),
}
