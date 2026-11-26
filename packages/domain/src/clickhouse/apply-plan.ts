// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
/**
 * Apply-plan expansion: turn a migration's statements into an ordered list of
 * executable steps, splitting each {@link BackfillSpec} into time-windowed
 * chunks so no single statement exceeds the Cloudflare Worker subrequest budget.
 *
 * The driver (the schema-apply Workflow, or the standalone CLI) executes each
 * step's `sql` in order; the Workflow additionally wraps each in a durable
 * `step.do(step.name, …)` for resumability + progress.
 */
import { Option, Schema, Array as Arr, String as Str } from "effect"

import {
	compileBackfillChunk,
	isBackfill,
	renderBackfillFull,
	renderStatementFull,
	type BackfillSpec,
} from "./backfill"
import type { ClickHouseMigration } from "./migrations"
import {
	dropUnkeyedColumnSql,
	isDropUnkeyedColumn,
	isRepairZeroKeyColumn,
	keyColumnProbeSql,
	repairZeroKeyColumnSql,
	unkeyedColumnProbeSql,
	zeroKeyRowsProbeSql,
} from "./unkeyed-column"

export interface ApplyStep {
	/** Stable, unique step name — the Workflow's durable step key + UI label. */
	readonly name: string
	readonly sql: string
	/** True for backfill chunks (long-running); false for structural DDL. */
	readonly backfill: boolean
	/**
	 * Run when this step fails, before its failure is reported: the `SYSTEM START MERGES` of a
	 * `SYSTEM STOP MERGES` an earlier step ran, so a failed apply never leaves merges stopped.
	 */
	readonly onFailure?: string
	/** Restores the pair's column DEFAULT before `onFailure` restarts merges; see {@link RestoreDefault}. */
	readonly restoreBeforeRestart?: RestoreDefault
}

/**
 * A pair that stops merges while a key column has no DEFAULT: a merge then would store the type's
 * 0 in every row it writes. On failure the DEFAULT is set again and checked before merges restart;
 * if it cannot be confirmed, merges stay stopped and the failure carries `recovery`.
 */
export interface RestoreDefault {
	/** The pair's own `MODIFY COLUMN ... DEFAULT` statement. */
	readonly sql: string
	/** One JSONEachRow row with the column's `default_expression`; no row when it does not exist. */
	readonly verifySql: string
	readonly expected: string
	/** What an operator runs by hand when merges were left stopped. */
	readonly recovery: string
}

/**
 * Whether merges may restart after `verifySql` answered `response`: the column is absent (the
 * key ALTER never ran, so no row can hold its 0) or its DEFAULT is back.
 */
export const defaultRestored = (restore: RestoreDefault, response: string): boolean => {
	const row = parseFirstRow(response)
	return row === null || row.default_expression === restore.expected
}

export type ExecFn = (sql: string) => Promise<string>

/** Smallest backfill chunk window. One day comfortably fits the Worker cap. */
const DAY_SECONDS = 24 * 60 * 60

/**
 * Upper bound on chunks per backfill. Keeps a workflow under Cloudflare's
 * free-tier 1,024-step cap even for multi-year retention; for long spans the
 * window grows (rounded up to whole days) so each chunk stays day-aligned and
 * still well under the per-request budget.
 */
const MAX_CHUNKS = 400

const chunkWindowSeconds = (spanSeconds: number): number => {
	if (spanSeconds <= 0) return DAY_SECONDS
	const days = Math.ceil(spanSeconds / MAX_CHUNKS / DAY_SECONDS)
	return Math.max(1, days) * DAY_SECONDS
}

const ident = (db: string, name: string): string => `\`${db}\`.\`${name}\``

const toChDateTime = (unixSeconds: number): string => {
	const d = new Date(unixSeconds * 1000)
	const p = (n: number): string => Str.padStart(2, "0")(String(n))
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

const decodeJsonRow = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const parseFirstRow = (text: string): Record<string, unknown> | null => {
	for (const line of Str.split("\n")(text)) {
		const trimmed = Str.trim(line)
		if (trimmed.length === 0) continue
		// The query is ours and asks for JSONEachRow, so a line that does not decode
		// is a warning or a blank the server interleaved — skip to the next one.
		const row = decodeJsonRow(trimmed)
		if (Option.isSome(row)) return row.value
	}
	return null
}

/**
 * Expand one backfill into day-aligned chunk steps by reading the source's
 * `[min,max]` of `tsColumn`. Empty source → a single full (zero-row) step so the
 * statement still "runs" and the migration completes.
 */
export const expandBackfill = async (
	spec: BackfillSpec,
	database: string,
	exec: ExecFn,
): Promise<ReadonlyArray<ApplyStep>> => {
	const bounds = parseFirstRow(
		await exec(
			`SELECT toUnixTimestamp(min(${spec.tsColumn})) AS lo, toUnixTimestamp(max(${spec.tsColumn})) AS hi FROM ${ident(database, spec.from)} FORMAT JSONEachRow`,
		),
	)
	const lo = bounds ? Number(bounds.lo) : 0
	const hi = bounds ? Number(bounds.hi) : 0
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= 0) {
		return [
			{
				name: `backfill:${spec.target}:empty`,
				sql: renderBackfillFull(spec, database),
				backfill: true,
			},
		]
	}

	const steps: ApplyStep[] = []
	const start = Math.floor(lo / DAY_SECONDS) * DAY_SECONDS
	const windowSeconds = chunkWindowSeconds(hi - start)
	for (let w = start; w <= hi; w += windowSeconds) {
		const from = toChDateTime(w)
		const to = toChDateTime(w + windowSeconds)
		steps.push({
			name: `backfill:${spec.target}:${Str.slice(0, 10)(from)}`,
			sql: compileBackfillChunk(spec, database, from, to),
			backfill: true,
		})
	}
	return steps
}

/**
 * Expand a migration into ordered, individually-executable steps. Structural
 * statements map 1:1; backfills expand into N day-window chunk steps.
 */
export const expandMigrationToSteps = async (
	migration: ClickHouseMigration,
	database: string,
	exec: ExecFn,
): Promise<ReadonlyArray<ApplyStep>> => {
	const steps: ApplyStep[] = []
	let index = 0
	for (const stmt of migration.statements) {
		if (isBackfill(stmt)) {
			steps.push(...(await expandBackfill(stmt, database, exec)))
		} else if (isDropUnkeyedColumn(stmt)) {
			const unkeyed = parseFirstRow(await exec(unkeyedColumnProbeSql(stmt, database)))
			if (unkeyed !== null)
				steps.push({
					name: `m${migration.version}:stmt${index}`,
					sql: dropUnkeyedColumnSql(stmt, database),
					backfill: false,
				})
		} else if (isRepairZeroKeyColumn(stmt)) {
			// The column is probed first: on a store before the migration it does not exist yet.
			const keyed = parseFirstRow(await exec(keyColumnProbeSql(stmt, database))) !== null
			const zeros = keyed ? parseFirstRow(await exec(zeroKeyRowsProbeSql(stmt, database))) : null
			if (zeros !== null && zeros.zeros !== "0") {
				const [copy, remove] = repairZeroKeyColumnSql(stmt, database)
				steps.push(
					{ name: `m${migration.version}:stmt${index}:copy`, sql: copy, backfill: false },
					{ name: `m${migration.version}:stmt${index}:delete`, sql: remove, backfill: false },
				)
			}
		} else {
			steps.push({
				name: `m${migration.version}:stmt${index}`,
				sql: renderStatementFull(stmt, database),
				backfill: false,
			})
		}
		index += 1
	}
	return restartMergesOnFailure(steps, database)
}

const STOP_MERGES = /^SYSTEM STOP MERGES (\S+)$/
const SET_DEFAULT = /^ALTER TABLE (?:\S+\.)?`?(\w+)`? MODIFY COLUMN `?(\w+)`? \S+ DEFAULT (.+)$/

/** The pair's `MODIFY COLUMN ... DEFAULT`, as a restore an executor runs before restarting merges. */
const restoreFor = (
	pair: ReadonlyArray<ApplyStep>,
	restart: string,
	database: string,
): RestoreDefault | undefined => {
	for (const step of pair) {
		const sql = Str.trim(step.sql)
		const match = SET_DEFAULT.exec(sql)
		const [, table, column, expected] = match ?? []
		if (table === undefined || column === undefined || expected === undefined) continue
		const db = database.length === 0 ? "currentDatabase()" : `'${Str.replace(/'/g, "''")(database)}'`
		return {
			sql,
			verifySql: `SELECT default_expression FROM system.columns WHERE database = ${db} AND table = '${table}' AND name = '${column}' FORMAT JSONEachRow`,
			expected: Str.trim(expected),
			recovery: `Merges on ${table} were left stopped because ${column}'s DEFAULT could not be restored; a merge would store 0 in it. Run \`${sql}\`, then \`${restart}\`.`,
		}
	}
	return undefined
}

/**
 * Every step between a `SYSTEM STOP MERGES <t>` and its `SYSTEM START MERGES <t>` restarts them on
 * failure, after restoring the pair's column DEFAULT when it sets one.
 */
const restartMergesOnFailure = (
	steps: ReadonlyArray<ApplyStep>,
	database: string,
): ReadonlyArray<ApplyStep> => {
	const out: ApplyStep[] = []
	let index = 0
	while (index < steps.length) {
		const step = Arr.getUnsafe(steps, index)
		const stopped = Option.fromNullishOr(STOP_MERGES.exec(Str.trim(step.sql))?.[1])
		out.push(step)
		index += 1
		if (Option.isNone(stopped)) continue
		const restart = `SYSTEM START MERGES ${stopped.value}`
		const end = Option.getOrElse(
			Arr.findFirstIndex(Arr.drop(steps, index), (candidate) => Str.trim(candidate.sql) === restart),
			() => steps.length - index,
		)
		const pair = Arr.take(Arr.drop(steps, index), end)
		const restore = restoreFor(pair, restart, database)
		for (const inside of pair)
			out.push(
				restore === undefined
					? { ...inside, onFailure: restart }
					: { ...inside, onFailure: restart, restoreBeforeRestart: restore },
			)
		index += end
	}
	return out
}
