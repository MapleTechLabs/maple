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
 * v23 adds `ai_trace_index_claude_code_cost_mv`, a second view into
 * `ai_trace_index` that writes one usage record per Claude Code `api_request`
 * log event: the call's cost, keyed by the request id its
 * `claude_code.llm_request` span carries as `gen_ai.response.id`. No column
 * changes and no existing view is touched, so the v23 bootstrap's
 * `CREATE MATERIALIZED VIEW IF NOT EXISTS` is the whole edge.
 *
 * NOTHING IS BACKFILLED, as in 0033: events already in `logs` stay unpriced in
 * the index until raw retention ages them out. The managed side accepts the
 * same gap.
 *
 * Idempotent, so a resume after a crash lands in the same place.
 */

/** Stamped into the journal and matched on the way back out. */
const MODULE_ID = "local-0022-to-0023-ai-trace-index-claude-code-cost" as const

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

const apply = (context: MigrationModuleContext): Promise<V22ToV23Progress> =>
	// The v23 bootstrap creates the new view; every other object already exists
	// and its `IF NOT EXISTS` is a no-op.
	context.openTarget(() => ({ installed: true }), {
		schemaSql: LOCAL_SCHEMA_V23_SQL,
		bootstrapSchema: true,
	})

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
		id: "create-claude-code-cost-view",
		description:
			"Create ai_trace_index_claude_code_cost_mv, which writes each Claude Code api_request event's cost to ai_trace_index",
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
		name: "logs",
		classification: "authoritative",
		disposition: "preserve-exact",
		guarantee: "The new view's source is neither read nor rewritten by the edge; only a view is added.",
	},
	{
		// Forward-only, bounded by the 30-day TTL, and the same gap the managed
		// side accepts.
		name: "ai_trace_index",
		classification: "derived",
		disposition: "rebuild-within-retention-horizon",
		guarantee:
			"Existing rows are preserved untouched; the new view adds a usage record for each Claude Code api_request event ingested after the migration, and the unpriced gap closes as the retention window rolls.",
		preservationInterval: "from the migration forward",
		sourceRetentionDays: 30,
		targetRetentionDays: 30,
	},
]

export const v22ToV23AiTraceIndexClaudeCodeCostModule: LocalStoreMigrationModule<
	V22ToV23State,
	V22ToV23Progress
> = {
	id: MODULE_ID,
	moduleVersion: 1,
	description:
		"Materialize the cost of each Claude Code model call into ai_trace_index from its api_request log event",
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
