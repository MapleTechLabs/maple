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
	LOCAL_SCHEMA_V19,
	LOCAL_SCHEMA_V19_MANIFEST,
	LOCAL_SCHEMA_V19_SQL,
	LOCAL_SCHEMA_V20,
	LOCAL_SCHEMA_V20_MANIFEST,
	LOCAL_SCHEMA_V20_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0019-to-0020-error-events-attribute-fallback" as const

class RowCountMismatch extends Schema.TaggedError<RowCountMismatch>()("@maple/cli/RowCountMismatch", {
	message: Schema.String,
	moduleId: Schema.String,
	table: Schema.String,
	expected: UnsignedDecimal,
	actual: UnsignedDecimal,
}) {}

const V19ToV20StateCodec = makeRawRowsState(MODULE_ID)

type V19ToV20State = typeof V19ToV20StateCodec.schema.Type
type V19ToV20Progress = InstalledProgress

const decodeState = V19ToV20StateCodec.decode
const decodeProgress = decodeInstalledProgress

/** Replace the two view definitions from migration 0030, preserving stored rows. */
const preflight = async (context: MigrationModuleContext): Promise<V19ToV20State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V19_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V19_SQL, bootstrapSchema: false },
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
	state: V19ToV20State,
): Promise<V19ToV20State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

/**
 * Like v7 -> v8, this edge replaces the body of two existing views rather than
 * adding anything. A materialized view's SELECT is frozen at creation and the
 * bundled DDL uses `CREATE ... IF NOT EXISTS`, so both views must be dropped
 * before the v20 schema can install its versions. Dropping a view never touches
 * rows already in its target table.
 */
const apply = async (context: MigrationModuleContext): Promise<V19ToV20Progress> => {
	await context.openTarget(
		(db) => {
			db.exec("DROP TABLE IF EXISTS error_events_mv")
			db.exec("DROP TABLE IF EXISTS error_events_by_time_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V19_SQL, bootstrapSchema: false },
	)
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V20_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V19ToV20State,
	_progress: V19ToV20Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V20_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new RowCountMismatch({
						message: `v19 -> v20 raw telemetry verification failed for ${table}`,
						moduleId: MODULE_ID,
						table,
						expected: state.rawRows[table] ?? "0",
						actual: targetRows[table] ?? "0",
					})
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V20_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v19-store",
		description: "Clone the stopped v19 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "rebuild-error-events-views",
		description:
			"Drop and recreate the error-events views so an exception-less span is labelled from its exception.* / error.* attributes",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v20-schema",
		description: "Verify the v20 physical schema and retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v19 store is cloned byte-for-byte before the views are replaced.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the replaced views is neither read nor rewritten; only the view definitions change.",
	},
	{
		// Rows already materialized keep their 'Unknown Error' label and hash —
		// error_events holds no span attributes to re-derive them from, and
		// recomputing hashes would re-bucket every existing issue. Forward-only,
		// and bounded by the tables' 90-day TTL.
		name: "error_events",
		classification: "derived",
		disposition: "preserve-exact",
		guarantee:
			"Existing rows are preserved untouched; the attribute fallback applies to events materialized after the migration and converges as the retention window rolls.",
		preservationInterval: "error retention horizon",
		sourceRetentionDays: 90,
		targetRetentionDays: 90,
	},
	{
		name: "error_events_by_time",
		classification: "derived",
		disposition: "preserve-exact",
		guarantee:
			"Same projection as error_events and treated identically: preserved rows, forward-only correction.",
		preservationInterval: "error retention horizon",
		sourceRetentionDays: 90,
		targetRetentionDays: 90,
	},
]

export const v19ToV20ErrorEventsAttributeFallbackModule: LocalStoreMigrationModule<
	V19ToV20State,
	V19ToV20Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Rebuild the error-events views so an exception-less span is labelled from its exception.* / error.* attributes",
	from: LOCAL_SCHEMA_V19,
	to: LOCAL_SCHEMA_V20,
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
