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
	LOCAL_SCHEMA_V20,
	LOCAL_SCHEMA_V20_MANIFEST,
	LOCAL_SCHEMA_V20_SQL,
	LOCAL_SCHEMA_V21,
	LOCAL_SCHEMA_V21_MANIFEST,
	LOCAL_SCHEMA_V21_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/**
 * The local mirror of ClickHouse migration 0031.
 *
 * v21 widens `ai_trace_index` with the last facts the Agent Sessions list read
 * off the raw spans — the vendor's version (`maple_ai.vendor.version`, the
 * framework badge on the row) and the five disjoint token buckets `Tokens` is
 * the sum of (`genAiUsageBucketsExpr`, the usage bar) — and recreates
 * `ai_trace_index_mv` to fill them, so the list renders a row from one index
 * query instead of a fan-out over `trace_detail_spans`. No row moves and no
 * table is rebuilt.
 *
 * Two things the bundled v21 DDL cannot do on its own, both done in a
 * pre-bootstrap block exactly as the v18 -> v19 edge did:
 *
 * 1. Widen the table. The DDL is `CREATE TABLE IF NOT EXISTS`, a no-op against
 *    the v20 table, so the explicit `ADD COLUMN IF NOT EXISTS` is what adds the
 *    columns — metadata-only, defaulting every existing row to `''`/0.
 * 2. Replace the view. A materialized view's SELECT is frozen at creation, so
 *    the v20 view is dropped first or it simply survives the bootstrap's
 *    `IF NOT EXISTS`.
 *
 * NOTHING IS BACKFILLED, as in 0031: rows materialized under v20 keep `''` for
 * the version and 0 for every bucket — the list falls back to the index's
 * `Tokens` total for the bar and to `''` for the version — until raw `traces`'
 * retention ages them out. The managed side accepts the same gap.
 *
 * Every statement is idempotent, so a resume after a crash lands in the same
 * place.
 */

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0020-to-0021-ai-trace-index-list-columns" as const

/** Columns v21 adds to `ai_trace_index`, with the type the v21 DDL declares. */
const ADDED_COLUMNS = [
	["VendorVersion", "LowCardinality(String)"],
	["InputTokens", "Float64"],
	["CacheReadTokens", "Float64"],
	["CacheWriteTokens", "Float64"],
	["OutputTokens", "Float64"],
	["ReasoningTokens", "Float64"],
] as const

class RowCountMismatch extends Schema.TaggedError<RowCountMismatch>()("@maple/cli/RowCountMismatch", {
	message: Schema.String,
	moduleId: Schema.String,
	table: Schema.String,
	expected: UnsignedDecimal,
	actual: UnsignedDecimal,
}) {}

const V20ToV21StateCodec = makeRawRowsState(MODULE_ID)

type V20ToV21State = typeof V20ToV21StateCodec.schema.Type
type V20ToV21Progress = InstalledProgress

const decodeState = V20ToV21StateCodec.decode
const decodeProgress = decodeInstalledProgress

const preflight = async (context: MigrationModuleContext): Promise<V20ToV21State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V20_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V20_SQL, bootstrapSchema: false },
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
	state: V20ToV21State,
): Promise<V20ToV21State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

const apply = async (context: MigrationModuleContext): Promise<V20ToV21Progress> => {
	await context.openTarget(
		(db) => {
			for (const [column, type] of ADDED_COLUMNS) {
				db.exec(`ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS ${column} ${type}`)
			}
			db.exec("DROP VIEW IF EXISTS ai_trace_index_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V20_SQL, bootstrapSchema: false },
	)
	// The v21 bootstrap recreates the view with its new SELECT; every other
	// object already exists and its `IF NOT EXISTS` is a no-op.
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V21_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V20ToV21State,
	_progress: V20ToV21Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V21_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new RowCountMismatch({
						message: `v20 -> v21 raw telemetry verification failed for ${table}`,
						moduleId: MODULE_ID,
						table,
						expected: state.rawRows[table] ?? "0",
						actual: targetRows[table] ?? "0",
					})
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V21_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v20-store",
		description: "Clone the stopped v20 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "widen-ai-trace-index",
		description:
			"Add the vendor version and the five token buckets to ai_trace_index and rebuild ai_trace_index_mv to fill them",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v21-schema",
		description: "Verify the v21 physical schema and the retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v20 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the replaced view is neither read nor rewritten; only the view definition and the index's column list change.",
	},
	{
		// Existing rows are kept with an empty VendorVersion and zeroed buckets.
		// The rebuilt MV fills both for spans ingested after the edge.
		// Forward-only, bounded by the 30-day TTL, and the same gap the managed
		// side accepts.
		name: "ai_trace_index",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched with an empty VendorVersion and zeroed token buckets; the rebuilt view fills them for spans materialized after the migration and the gap closes as the retention window rolls.",
		preservationInterval: "from the migration forward",
		sourceRetentionDays: 30,
		targetRetentionDays: 30,
	},
]

export const v20ToV21AiTraceIndexListColumnsModule: LocalStoreMigrationModule<
	V20ToV21State,
	V20ToV21Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Add the vendor version and the five token buckets to ai_trace_index and recreate ai_trace_index_mv to fill them",
	from: LOCAL_SCHEMA_V20,
	to: LOCAL_SCHEMA_V21,
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
