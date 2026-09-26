// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
// The one executor behind every row of `steps.ts`: clone the stopped store, alter
// the clone, bootstrap the target snapshot over it, verify, and never touch the source.
import { resolve } from "node:path"
import { Schema } from "effect"
import { readRawTelemetryRetentionDays, type Chdb } from "../chdb"
import { decodeJsonObjectRows } from "../chdb-rows"
import type {
	LocalStoreMigrationModule,
	MigrationOperation,
	StateDispositionEntry,
} from "../local-store-migration-module"
import { localSchemaIdentity, localSchemaSnapshot } from "../schema-identity"
import { assertPhysicalSchema } from "../schema-physical"
import {
	cloneStoreForStaging,
	expectedManifest,
	RAW_TABLES,
	rawRowCounts,
	retainedRawRowCounts,
	strictDecoder,
	UnsignedDecimal,
} from "./journal-codecs"

/** A journaled step state or progress this build cannot resume, or a count query with no row. */
export class LocalMigrationStepError extends Schema.TaggedError<LocalMigrationStepError>()(
	"@maple/cli/LocalMigrationStepError",
	{ message: Schema.String, moduleId: Schema.String },
) {}

/** A row count the target does not reproduce; `table` names the table or the count key. */
export class RowCountMismatch extends Schema.TaggedError<RowCountMismatch>()("@maple/cli/RowCountMismatch", {
	message: Schema.String,
	moduleId: Schema.String,
	table: Schema.String,
	expected: UnsignedDecimal,
	actual: UnsignedDecimal,
}) {}

/** One typed schema change; each renders to idempotent SQL run against the staged target. */
export type StepOperation =
	| {
			readonly op: "add-columns"
			readonly table: string
			readonly columns: ReadonlyArray<readonly [name: string, type: string]>
	  }
	| { readonly op: "add-index"; readonly table: string; readonly index: string }
	| { readonly op: "drop-columns"; readonly table: string; readonly columns: ReadonlyArray<string> }
	| { readonly op: "drop"; readonly kind: "TABLE" | "VIEW"; readonly names: ReadonlyArray<string> }
	| { readonly op: "backfill"; readonly statements: ReadonlyArray<string> }

export const addColumns = (
	table: string,
	columns: ReadonlyArray<readonly [name: string, type: string]>,
): StepOperation => ({ op: "add-columns", table, columns })

/** `index` is everything after `ADD INDEX IF NOT EXISTS`. */
export const addIndex = (table: string, index: string): StepOperation => ({ op: "add-index", table, index })

export const dropColumns = (table: string, columns: ReadonlyArray<string>): StepOperation => ({
	op: "drop-columns",
	table,
	columns,
})

export const dropViews = (...names: ReadonlyArray<string>): StepOperation => ({
	op: "drop",
	kind: "VIEW",
	names,
})

/** chDB stores a materialized view as a table, so this also removes views; older steps spell it so. */
export const dropTables = (...names: ReadonlyArray<string>): StepOperation => ({
	op: "drop",
	kind: "TABLE",
	names,
})

export const backfill = (...statements: ReadonlyArray<string>): StepOperation => ({
	op: "backfill",
	statements,
})

const operationSql = (operation: StepOperation): ReadonlyArray<string> => {
	switch (operation.op) {
		case "add-columns":
			return operation.columns.map(
				([name, type]) => `ALTER TABLE ${operation.table} ADD COLUMN IF NOT EXISTS ${name} ${type}`,
			)
		case "add-index":
			return [`ALTER TABLE ${operation.table} ADD INDEX IF NOT EXISTS ${operation.index}`]
		case "drop-columns":
			return operation.columns.map(
				(column) => `ALTER TABLE ${operation.table} DROP COLUMN IF EXISTS ${column}`,
			)
		case "drop":
			return operation.names.map((name) => `DROP ${operation.kind} IF EXISTS ${name}`)
		case "backfill":
			return operation.statements
	}
}

/** The exact statements a list of operations runs, in order. */
export const stepStatements = (operations: ReadonlyArray<StepOperation>): ReadonlyArray<string> =>
	operations.flatMap(operationSql)

/** A count compared on the target in verify against the value the source recorded. */
export interface CountCheck {
	readonly key: string
	/** Target query; defaults to the key's own source query. */
	readonly sql?: string
	readonly failure: (expected: string, found: string) => string
}

/** Extra row counts a step records on the source and re-checks on the target. */
export interface StepCounts {
	/** Journal key the counts persist under: part of the resume format, never rename it. */
	readonly group: string
	/** `toString(...) AS count` queries run on the source in preflight, in this order. */
	readonly measure: ReadonlyArray<readonly [key: string, sql: string]>
	/** Every check's query runs first, then the comparisons fail in this order. */
	readonly checks: ReadonlyArray<CountCheck>
}

export const unchangedRowCount = (key: string): CountCheck => ({
	key,
	failure: (expected, found) => `${key} row count changed: expected ${expected}, found ${found}`,
})

/** Journal state every step persists; `StepCounts.group` adds one more key. */
export interface StepState {
	readonly module: string
	readonly version: 1
	readonly rawRows: Readonly<Record<string, string>>
	readonly retentionDays?: number
	/** UTC day the raw counts were taken; absent in journals from older binaries. */
	readonly countedOn?: string
	readonly [group: string]: unknown
}

/** Journaled step progress: `INSTALLED`, or the flat record a custom step's schema decodes. */
export type StepProgress = { readonly [field: string]: string | number | boolean }

/** The escape hatch: runs inside the bootstrapped target session and owns its own progress. */
export interface StepCustom {
	/** Strictly decodes the journaled progress; `apply` returns the same shape. */
	readonly progress: Schema.Codec<StepProgress, unknown>
	readonly apply: (db: Chdb, state: StepState) => StepProgress
	readonly verify: (db: Chdb, state: StepState, progress: StepProgress) => void
}

export const customStep = <Progress extends StepProgress>(custom: {
	readonly progress: Schema.Codec<Progress, unknown>
	readonly apply: (db: Chdb, state: StepState) => Progress
	readonly verify: (db: Chdb, state: StepState, progress: Progress) => void
}): StepCustom => {
	const decodeProgress = strictDecoder(custom.progress)
	return {
		progress: custom.progress,
		apply: custom.apply,
		verify: (db, state, progress) => custom.verify(db, state, decodeProgress(progress)),
	}
}

export interface StepSpec {
	readonly id: string
	readonly from: number
	readonly to: number
	readonly description: string
	/** Completes "The clean stopped v<from> store is cloned byte-for-byte before ...". */
	readonly clonedBefore: string
	/** Runs on the clone under the v<from> DDL: what an `IF NOT EXISTS` bootstrap cannot do. */
	readonly beforeBootstrap?: ReadonlyArray<StepOperation>
	/** Runs in the session that bootstrapped the v<to> snapshot. */
	readonly afterBootstrap?: ReadonlyArray<StepOperation>
	readonly counts?: StepCounts
	readonly custom?: StepCustom
	/** Plan lines between the derived clone and verify lines, all in the copying phase. */
	readonly plan: ReadonlyArray<readonly [id: string, description: string]>
	readonly verifies: string
	readonly dispositions: ReadonlyArray<StateDispositionEntry>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value)

const INSTALLED = Object.freeze({ installed: true })

/** Compile one table row into the coordinator's module interface. */
export const stepModule = (spec: StepSpec): LocalStoreMigrationModule<StepState, StepProgress> => {
	const source = localSchemaSnapshot(spec.from)
	const target = localSchemaSnapshot(spec.to)
	const label = `v${spec.from} -> v${spec.to}`
	const fail = (message: string): never => {
		throw new LocalMigrationStepError({ message, moduleId: spec.id })
	}
	const countKeys = spec.counts?.measure.map(([key]) => key) ?? []
	const measureSql = new Map(spec.counts?.measure ?? [])

	// Messages and check order match the hand-written decoders these steps replaced.
	const decodeRawRows = (value: unknown): Readonly<Record<string, string>> => {
		if (!isRecord(value)) return fail(`${label} rawRows must be an object`)
		const counts: Record<string, string> = {}
		for (const table of RAW_TABLES) {
			const count = value[table]
			if (!isCount(count)) return fail(`${label} rawRows.${table} must be an unsigned decimal string`)
			counts[table] = count
		}
		if (Object.keys(value).some((table) => !RAW_TABLES.includes(table)))
			return fail(`${label} rawRows contains an unknown table`)
		return counts
	}

	const decodeCountGroup = (group: string, value: unknown): ReadonlyMap<string, string> => {
		if (!isRecord(value)) return fail(`${label} ${group} must be an object`)
		if (Object.keys(value).some((key) => !countKeys.includes(key)))
			return fail(`${label} ${group} contains an unknown field`)
		const counts = new Map<string, string>()
		for (const key of countKeys) {
			const count = value[key]
			if (!isCount(count)) return fail(`${label} ${group}.${key} must be an unsigned decimal string`)
			counts.set(key, count)
		}
		return counts
	}

	const makeState = (
		rawRows: Readonly<Record<string, string>>,
		counts: Readonly<Record<string, string>> | undefined,
		retentionDays: number | undefined,
		countedOn: string | undefined,
	): StepState => {
		const state: StepState = {
			module: spec.id,
			version: 1,
			rawRows,
			...(spec.counts === undefined || counts === undefined
				? undefined
				: { [spec.counts.group]: counts }),
			...(retentionDays === undefined ? undefined : { retentionDays }),
		}
		return countedOn === undefined ? state : { ...state, countedOn }
	}

	const decodeState = (value: unknown): StepState => {
		if (!isRecord(value)) return fail(`${label} state must be an object`)
		const allowed = new Set(["module", "version", "rawRows", "retentionDays", "countedOn"])
		if (spec.counts !== undefined) allowed.add(spec.counts.group)
		if (Object.keys(value).some((key) => !allowed.has(key)))
			return fail(`${label} state contains an unknown field`)
		if (value.module !== spec.id || value.version !== 1)
			return fail(`${label} state has an unsupported module or version`)
		const retentionDays = value.retentionDays
		if (
			retentionDays !== undefined &&
			(typeof retentionDays !== "number" || !Number.isSafeInteger(retentionDays))
		)
			return fail(`${label} retentionDays must be an integer`)
		const countedOn = value.countedOn
		if (
			countedOn !== undefined &&
			(typeof countedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(countedOn))
		)
			return fail(`${label} countedOn must be a YYYY-MM-DD day`)
		const rawRows = decodeRawRows(value.rawRows)
		const counts =
			spec.counts === undefined
				? undefined
				: Object.fromEntries(decodeCountGroup(spec.counts.group, value[spec.counts.group]))
		return makeState(rawRows, counts, retentionDays, countedOn)
	}

	const decodeCustomProgress = spec.custom === undefined ? undefined : strictDecoder(spec.custom.progress)
	const decodeProgress = (value: unknown): StepProgress | undefined => {
		if (value === undefined) return undefined
		if (decodeCustomProgress !== undefined) return decodeCustomProgress(value)
		if (
			!isRecord(value) ||
			Object.keys(value).some((key) => key !== "installed") ||
			value.installed !== true
		)
			return fail(`${label} progress is invalid`)
		return INSTALLED
	}

	const scalarCount = (db: Chdb, sql: string): string => {
		const count = decodeJsonObjectRows(db.query(sql))[0]?.count
		return isCount(count) ? count : fail(`${label} count query returned no row: ${sql}`)
	}

	const run = (db: Chdb, operations: ReadonlyArray<StepOperation> | undefined): void => {
		for (const statement of stepStatements(operations ?? [])) db.exec(statement)
	}

	const verifyCounts = (db: Chdb, counts: StepCounts, state: StepState): void => {
		const expected = decodeCountGroup(counts.group, state[counts.group])
		const found = counts.checks.map((check) => ({
			check,
			count: scalarCount(
				db,
				check.sql ??
					measureSql.get(check.key) ??
					fail(`${label} has no count query for ${check.key}`),
			),
		}))
		for (const { check, count } of found) {
			const want = expected.get(check.key) ?? fail(`${label} ${counts.group} has no ${check.key}`)
			if (count !== want)
				throw new RowCountMismatch({
					message: `${label} ${check.failure(want, count)}`,
					moduleId: spec.id,
					table: check.key,
					expected: want,
					actual: count,
				})
		}
	}

	const operations: ReadonlyArray<MigrationOperation> = [
		{
			id: `clone-v${spec.from}-store`,
			description: `Clone the stopped v${spec.from} store into the staged migration target`,
			requiresQuiescence: true,
			phase: "target-created",
		},
		...spec.plan.map(
			([id, description]): MigrationOperation => ({
				id,
				description,
				requiresQuiescence: true,
				phase: "copying",
			}),
		),
		{
			id: `verify-v${spec.to}-schema`,
			description: spec.verifies,
			requiresQuiescence: true,
			phase: "copy-verified",
		},
	]

	return {
		id: spec.id,
		moduleVersion: 1,
		description: spec.description,
		from: localSchemaIdentity(spec.from),
		to: localSchemaIdentity(spec.to),
		operations,
		dispositions: [
			{
				name: "local store",
				classification: "authoritative",
				disposition: "preserve-exact",
				guarantee: `The clean stopped v${spec.from} store is cloned byte-for-byte before ${spec.clonedBefore}.`,
			},
			...spec.dispositions,
		],
		decodeState,
		decodeProgress,
		preflight: async (context) => {
			await context.ensureCapacity()
			const retentionDays = readRawTelemetryRetentionDays(context.dataDir)
			const countedOn = new Date().toISOString().slice(0, 10)
			const measured = await context.openSource(
				(db) => {
					const manifest = expectedManifest(source.manifest, retentionDays)
					assertPhysicalSchema(db, manifest)
					const rawRows = retainedRawRowCounts(db, manifest, countedOn)
					const counts = spec.counts?.measure.map(
						([key, sql]) => [key, scalarCount(db, sql)] as const,
					)
					return { rawRows, counts: counts === undefined ? undefined : Object.fromEntries(counts) }
				},
				{ schemaSql: source.sql, bootstrapSchema: false },
			)
			return makeState(measured.rawRows, measured.counts, retentionDays, countedOn)
		},
		prepareTarget: async (context, state) => {
			await context.closeStores()
			const sourceDir = resolve(context.sourceDataDir)
			const targetDir = resolve(context.targetDataDir)
			if (sourceDir !== targetDir) await cloneStoreForStaging(sourceDir, targetDir)
			return state
		},
		apply: async (context, state) => {
			if ((spec.beforeBootstrap ?? []).length > 0)
				await context.openTarget((db) => run(db, spec.beforeBootstrap), {
					schemaSql: source.sql,
					bootstrapSchema: false,
				})
			return context.openTarget(
				(db) => {
					run(db, spec.afterBootstrap)
					return spec.custom === undefined ? INSTALLED : spec.custom.apply(db, state)
				},
				{ schemaSql: target.sql, bootstrapSchema: true },
			)
		},
		verify: async (context, state, progress) => {
			await context.openTarget(
				(db) => {
					assertPhysicalSchema(db, expectedManifest(target.manifest, state.retentionDays))
					// Counted against the source's TTLs, as at preflight; older journals compare exact.
					const targetRows =
						typeof state.countedOn === "string"
							? retainedRawRowCounts(
									db,
									expectedManifest(source.manifest, state.retentionDays),
									state.countedOn,
								)
							: rawRowCounts(db)
					for (const table of RAW_TABLES) {
						if (targetRows[table] !== state.rawRows[table])
							throw new RowCountMismatch({
								message: `${label} raw telemetry verification failed for ${table}`,
								moduleId: spec.id,
								table,
								expected: state.rawRows[table] ?? "0",
								actual: targetRows[table] ?? "0",
							})
					}
					if (spec.counts !== undefined) verifyCounts(db, spec.counts, state)
					spec.custom?.verify(db, state, progress)
				},
				{ schemaSql: target.sql, bootstrapSchema: false },
			)
		},
		recover: async (_context, state, progress) => ({ state, progress }),
	}
}
