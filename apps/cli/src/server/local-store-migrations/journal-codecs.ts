// Shared helpers for the local-store migration steps: journal decoding, the
// raw-telemetry row counts every step preserves, and the clone into staging.
import { Schema } from "effect"
import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { RAW_TELEMETRY_TTL_COLUMNS, type Chdb } from "../chdb"
import { decodeRowCounts, decodeTableRowCounts } from "../chdb-rows"
import {
	ttlDaysFromDefinition,
	withRawTelemetryRetentionFloor,
	type LocalSchemaManifest,
} from "../schema-manifest"

const RAW_TABLES_INTERNAL = RAW_TELEMETRY_TTL_COLUMNS.map(([table]) => table)

/**
 * Unsigned decimal string.
 *
 * Row counts and ClickHouse UInt64 cursors are carried as text because they can
 * exceed `Number.MAX_SAFE_INTEGER`, and the journal has to round-trip them
 * exactly. The pattern is not cosmetic: these values are interpolated into SQL
 * comparisons, so anything that could change their meaning has to fail here.
 */
export const UnsignedDecimal = Schema.String.check(Schema.isPattern(/^\d+$/))

/**
 * Rejecting unknown fields is not tidiness. A journal carrying a field this
 * build does not know about was written by a different build, and silently
 * dropping it would resume someone else's migration under our assumptions.
 */
const strict = { onExcessProperty: "error" } as const

/** `decodeUnknownSync` with the strict excess-property policy. */
export const strictDecoder = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S) =>
	Schema.decodeUnknownSync(schema, strict)

/** Exactly the raw telemetry tables a migration must preserve, in a stable order. */
export const RAW_TABLES: ReadonlyArray<string> = RAW_TABLES_INTERNAL

/**
 * Row counts per raw table, straight from `system.parts`. The input to the one
 * guarantee every step makes: a structural DDL change moves no telemetry.
 */
export const rawRowCounts = (db: Chdb): Readonly<Record<string, string>> => {
	const quotedTables = RAW_TABLES_INTERNAL.map((table) => `'${table}'`).join(", ")
	const rows = decodeTableRowCounts(
		db.query(
			`SELECT table, toString(sum(rows)) AS rowCount FROM system.parts WHERE database = 'default' AND active = 1 AND table IN (${quotedTables}) GROUP BY table`,
		),
	)
	const byTable = new Map(rows.map((row) => [row.table, row.rowCount]))
	return Object.fromEntries(RAW_TABLES_INTERNAL.map((table) => [table, byTable.get(table) ?? "0"]))
}

/** A counted row must be at least this many days from its TTL on the count day. */
const RETAINED_MARGIN_DAYS = 2

/**
 * Row counts per raw table, limited to rows at least `RETAINED_MARGIN_DAYS` from
 * expiry on `countedOn` (YYYY-MM-DD). Opening a stopped store lets TTL merges drop
 * expired rows between the source and target counts, so an exact `system.parts`
 * comparison failed on every store holding rows past retention.
 */
export const retainedRawRowCounts = (
	db: Chdb,
	manifest: LocalSchemaManifest,
	countedOn: string,
): Readonly<Record<string, string>> =>
	Object.fromEntries(
		RAW_TELEMETRY_TTL_COLUMNS.map(([table, column]) => {
			const ttl = manifest.objects.find((object) => object.name === table)?.ttl
			const days = ttl === undefined ? null : ttlDaysFromDefinition(`TTL ${ttl}`)
			const retained =
				days === null
					? ""
					: ` WHERE toDate(${column}) >= toDate('${countedOn}') - ${Math.max(days - RETAINED_MARGIN_DAYS, 0)}`
			const rows = decodeRowCounts(
				db.query(`SELECT toString(count()) AS rowCount FROM ${table}${retained}`),
			)
			return [table, rows[0]?.rowCount ?? "0"]
		}),
	)

/**
 * The manifest a step should expect to find, given the retention floor an
 * operator pinned for this store. A pinned floor rewrites the raw tables' TTL
 * intervals, so comparing against the bundled manifest verbatim would report a
 * drift the operator asked for.
 */
export const expectedManifest = (
	manifest: LocalSchemaManifest,
	retentionDays: number | undefined,
): LocalSchemaManifest =>
	retentionDays === undefined
		? manifest
		: withRawTelemetryRetentionFloor(manifest, RAW_TABLES_INTERNAL, retentionDays)

/**
 * Clone a clean, stopped store into a staged migration target, WITHOUT its
 * checkpoint registry. `<dataDir>/backups` belongs to the retained source: its
 * manifests pin the source's schema fingerprint, so a copied registry fails
 * every post-promotion resolution against the new fingerprint, classifying the
 * registry "unusable" and blocking the fresh checkpoint the migration tells
 * the user to create. Checkpoints stay with the rollback source, as the stated
 * preservation envelope already promises.
 */
export const cloneStoreForStaging = async (source: string, target: string): Promise<void> => {
	await rm(target, { recursive: true, force: true })
	await mkdir(dirname(target), { recursive: true, mode: 0o700 })
	const checkpointRoot = join(source, "backups")
	await cp(source, target, {
		recursive: true,
		preserveTimestamps: true,
		filter: (src) => src !== checkpointRoot && !src.startsWith(`${checkpointRoot}${sep}`),
	})
}
