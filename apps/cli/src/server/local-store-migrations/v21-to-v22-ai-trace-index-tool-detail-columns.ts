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
	LOCAL_SCHEMA_V21,
	LOCAL_SCHEMA_V21_MANIFEST,
	LOCAL_SCHEMA_V21_SQL,
	LOCAL_SCHEMA_V22,
	LOCAL_SCHEMA_V22_MANIFEST,
	LOCAL_SCHEMA_V22_SQL,
} from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"

/**
 * The local mirror of ClickHouse migration 0032.
 *
 * v22 widens `ai_trace_index` with the facts the Agent Sessions TOOL DETAIL
 * page read off the raw spans — why a failing call failed (`error.type` and the
 * span's status message) and what a tool says it does
 * (`gen_ai.tool.description`) — and recreates `ai_trace_index_mv` to fill them,
 * so that page's Errors table, its failure modal's session pane and its header
 * render from the index instead of seeking `trace_detail_spans` across the
 * window's partitions. No row moves and no table is rebuilt.
 *
 * Two things the bundled v22 DDL cannot do on its own, both done in a
 * pre-bootstrap block exactly as the v20 -> v21 edge did:
 *
 * 1. Widen the table. The DDL is `CREATE TABLE IF NOT EXISTS`, a no-op against
 *    the v21 table, so the explicit `ADD COLUMN IF NOT EXISTS` is what adds the
 *    columns — metadata-only, defaulting every existing row to `''`.
 * 2. Replace the view. A materialized view's SELECT is frozen at creation, so
 *    the v21 view is dropped first or it simply survives the bootstrap's
 *    `IF NOT EXISTS`.
 *
 * NOTHING IS BACKFILLED, as in 0032: rows materialized under v21 keep `''` for
 * all three — a failure older than the edge groups under the page's `unknown`
 * row and a tool whose calls all predate it shows no description — until raw
 * `traces`' retention ages them out. The managed side accepts the same gap.
 *
 * Every statement is idempotent, so a resume after a crash lands in the same
 * place.
 */

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0021-to-0022-ai-trace-index-tool-detail-columns" as const

/** Columns v22 adds to `ai_trace_index`, with the type the v22 DDL declares. */
const ADDED_COLUMNS = [
	["ErrorType", "LowCardinality(String)"],
	["StatusMessage", "String"],
	["ToolDescription", "String"],
] as const

class RowCountMismatch extends Schema.TaggedError<RowCountMismatch>()("@maple/cli/RowCountMismatch", {
	message: Schema.String,
	moduleId: Schema.String,
	table: Schema.String,
	expected: UnsignedDecimal,
	actual: UnsignedDecimal,
}) {}

const V21ToV22StateCodec = makeRawRowsState(MODULE_ID)

type V21ToV22State = typeof V21ToV22StateCodec.schema.Type
type V21ToV22Progress = InstalledProgress

const decodeState = V21ToV22StateCodec.decode
const decodeProgress = decodeInstalledProgress

const preflight = async (context: MigrationModuleContext): Promise<V21ToV22State> => {
	await context.ensureCapacity()
	const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
	const rawRows = await context.openSource(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V21_MANIFEST, retentionDays))
			return rawRowCounts(db)
		},
		{ schemaSql: LOCAL_SCHEMA_V21_SQL, bootstrapSchema: false },
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
	state: V21ToV22State,
): Promise<V21ToV22State> => {
	await context.closeStores()
	const source = resolve(context.sourceDataDir)
	const target = resolve(context.targetDataDir)
	if (source !== target) {
		await cloneStoreForStaging(source, target)
	}
	return state
}

const apply = async (context: MigrationModuleContext): Promise<V21ToV22Progress> => {
	await context.openTarget(
		(db) => {
			for (const [column, type] of ADDED_COLUMNS) {
				db.exec(`ALTER TABLE ai_trace_index ADD COLUMN IF NOT EXISTS ${column} ${type}`)
			}
			db.exec("DROP VIEW IF EXISTS ai_trace_index_mv")
		},
		{ schemaSql: LOCAL_SCHEMA_V21_SQL, bootstrapSchema: false },
	)
	// The v22 bootstrap recreates the view with its new SELECT; every other
	// object already exists and its `IF NOT EXISTS` is a no-op.
	return context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V22_SQL,
		bootstrapSchema: true,
	})
}

const verify = async (
	context: MigrationModuleContext,
	state: V21ToV22State,
	_progress: V21ToV22Progress,
): Promise<void> => {
	await context.openTarget(
		(db) => {
			assertPhysicalSchema(db, expectedManifest(LOCAL_SCHEMA_V22_MANIFEST, state.retentionDays))
			const targetRows = rawRowCounts(db)
			for (const table of RAW_TABLES) {
				if (targetRows[table] !== state.rawRows[table])
					throw new RowCountMismatch({
						message: `v21 -> v22 raw telemetry verification failed for ${table}`,
						moduleId: MODULE_ID,
						table,
						expected: state.rawRows[table] ?? "0",
						actual: targetRows[table] ?? "0",
					})
			}
		},
		{ schemaSql: LOCAL_SCHEMA_V22_SQL, bootstrapSchema: false },
	)
}

const operations: ReadonlyArray<MigrationOperation> = [
	{
		id: "clone-v21-store",
		description: "Clone the stopped v21 store into the staged migration target",
		requiresQuiescence: true,
		phase: "target-created",
	},
	{
		id: "widen-ai-trace-index",
		description:
			"Add the failure type, the status message and the tool description to ai_trace_index and rebuild ai_trace_index_mv to fill them",
		requiresQuiescence: true,
		phase: "copying",
	},
	{
		id: "verify-v22-schema",
		description: "Verify the v22 physical schema and the retained raw telemetry counts",
		requiresQuiescence: true,
		phase: "copy-verified",
	},
]

const dispositions: ReadonlyArray<StateDispositionEntry> = [
	{
		name: "local store",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The clean stopped v21 store is cloned byte-for-byte before any DDL runs.",
	},
	{
		name: "traces",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee:
			"The source of the replaced view is neither read nor rewritten; only the view definition and the index's column list change.",
	},
	{
		// Existing rows are kept with an empty ErrorType, StatusMessage and
		// ToolDescription. The rebuilt MV fills them for spans ingested after
		// the edge.
		// Forward-only, bounded by the 30-day TTL, and the same gap the managed
		// side accepts.
		name: "ai_trace_index",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched with an empty failure type, status message and tool description; the rebuilt view fills them for spans materialized after the migration and the gap closes as the retention window rolls.",
		preservationInterval: "from the migration forward",
		sourceRetentionDays: 30,
		targetRetentionDays: 30,
	},
]

export const v21ToV22AiTraceIndexToolDetailColumnsModule: LocalStoreMigrationModule<
	V21ToV22State,
	V21ToV22Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Add the failure type, the status message and the tool description to ai_trace_index and recreate ai_trace_index_mv to fill them",
	from: LOCAL_SCHEMA_V21,
	to: LOCAL_SCHEMA_V22,
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
