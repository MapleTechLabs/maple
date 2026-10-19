// SAFETY-FILE: JSON rows here come from chDB's own JSONEachRow output for Maple-compiled SQL.
// Embedded chDB for the fixture warehouse, via `bun:ffi` and the same libchdb `apps/cli` loads.
// chDB allows one connection per process, so the backend opens it once and every dataset shares
// it, separated by OrgId (which every compiled query filters on).
import { CString, dlopen, FFIType, type Pointer, ptr, read, toArrayBuffer } from "bun:ffi"
import { Effect, Ref, Schema } from "effect"
import { existsSync, mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export class ParityChdbError extends Schema.TaggedError<ParityChdbError>()(
	"@maple/ui-parity/ParityChdbError",
	{
		message: Schema.String,
		sql: Schema.optionalKey(Schema.String),
	},
) {}

const libchdbPath = (): string | undefined =>
	[
		process.env.MAPLE_LIBCHDB,
		join(homedir(), ".maple", "bin", "libchdb.so"),
		join(homedir(), ".maple", "bin", "libchdb.dylib"),
	].find((candidate): candidate is string => candidate !== undefined && existsSync(candidate))

const openLib = (path: string) =>
	dlopen(path, {
		chdb_connect: { args: [FFIType.int, FFIType.ptr], returns: FFIType.ptr },
		chdb_close_conn: { args: [FFIType.ptr], returns: FFIType.void },
		chdb_query: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		chdb_result_buffer: { args: [FFIType.ptr], returns: FFIType.ptr },
		chdb_result_length: { args: [FFIType.ptr], returns: FFIType.u64 },
		chdb_result_error: { args: [FFIType.ptr], returns: FFIType.ptr },
		chdb_destroy_query_result: { args: [FFIType.ptr], returns: FFIType.void },
	}).symbols

type Symbols = ReturnType<typeof openLib>

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const cstr = (value: string): Uint8Array => encoder.encode(`${value}\0`)

export interface Chdb {
	/** Run one statement; returns the raw output in `format`. */
	readonly run: (sql: string, format?: string) => Effect.Effect<string, ParityChdbError>
	/** Run read SQL and parse its JSONEachRow output. */
	readonly rows: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, ParityChdbError>
	readonly dataDir: string
	/** Closes the connection once; later calls are no-ops. libchdb crashes at exit if left open. */
	readonly close: Effect.Effect<void>
}

const runWith =
	(symbols: Symbols, conn: Pointer) =>
	(sql: string, format = "CSV"): Effect.Effect<string, ParityChdbError> =>
		Effect.suspend(() => {
			const result = symbols.chdb_query(conn, ptr(cstr(sql)), ptr(cstr(format)))
			if (result === null)
				return Effect.fail(new ParityChdbError({ message: "chdb_query returned NULL", sql }))
			const errorPtr = symbols.chdb_result_error(result)
			const failure = errorPtr === null ? "" : new CString(errorPtr).toString()
			const length = Number(symbols.chdb_result_length(result))
			const buffer = failure.length > 0 || length === 0 ? null : symbols.chdb_result_buffer(result)
			const text =
				buffer === null ? "" : decoder.decode(new Uint8Array(toArrayBuffer(buffer, 0, length)))
			symbols.chdb_destroy_query_result(result)
			return failure.length > 0
				? Effect.andThen(
						drainPartialOutput(symbols, conn, 3),
						Effect.fail(new ParityChdbError({ message: failure, sql })),
					)
				: Effect.succeed(text)
		})

const DRAIN_SENTINEL = "maple-chdb-drain"
const DRAIN_SQL = cstr(`SELECT '${DRAIN_SENTINEL}' FORMAT RawBLOB`)
const DRAIN_FORMAT = cstr("RawBLOB")

/**
 * libchdb prepends a query's partial output after a mid-stream failure to the NEXT result, so read
 * it off with probes until one answers with only the sentinel, as `apps/cli`'s `Chdb` does.
 */
const drainPartialOutput = (symbols: Symbols, conn: Pointer, attemptsLeft: number): Effect.Effect<void> =>
	Effect.suspend(() => {
		if (attemptsLeft === 0) return Effect.void
		const result = symbols.chdb_query(conn, ptr(DRAIN_SQL), ptr(DRAIN_FORMAT))
		if (result === null) return Effect.void
		const errorPtr = symbols.chdb_result_error(result)
		const clean = errorPtr === null || new CString(errorPtr).toString().length === 0
		const length = Number(symbols.chdb_result_length(result))
		symbols.chdb_destroy_query_result(result)
		return clean && length === DRAIN_SENTINEL.length
			? Effect.void
			: drainPartialOutput(symbols, conn, attemptsLeft - 1)
	})

const Row = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeRow = Schema.decodeUnknownEffect(Row)

/**
 * `apps/cli`'s session settings (UTC instants, room for large inline INSERTs), plus one thread:
 * parallel UNION ALL branches otherwise return rows in a different order run to run.
 */
const SESSION_SETTINGS = [
	"SET session_timezone = 'UTC'",
	"SET max_query_size = 67108864",
	"SET max_threads = 1",
]

/**
 * Open the process's chDB connection in a fresh temp dir. The server timezone is pinned to UTC
 * before libchdb loads, as `apps/cli` does, so datetime literals parse as UTC.
 */
const open = Effect.gen(function* () {
	const path = libchdbPath()
	if (path === undefined)
		return yield* new ParityChdbError({
			message: "libchdb not found: set MAPLE_LIBCHDB or install it at ~/.maple/bin/libchdb.so",
		})
	process.env.TZ = "UTC"
	const symbols = openLib(path)
	const dataDir = mkdtempSync(join(tmpdir(), "maple-ui-parity-chdb-"))
	const args = [
		"clickhouse",
		"--async_load_databases=0",
		"--async_load_system_database=0",
		"--output_format_json_quote_64bit_integers=0",
		`--path=${dataDir}`,
	].map(cstr)
	const argv = new BigUint64Array(args.map((arg) => BigInt(ptr(arg))))
	const connPtr = symbols.chdb_connect(args.length, ptr(argv))
	const conn = connPtr === null ? null : read.ptr(connPtr, 0)
	if (conn === null || conn === 0)
		return yield* new ParityChdbError({ message: `chdb_connect failed for ${dataDir}` })
	// SAFETY: `read.ptr` returns the connection address the C API hands back; non-null was checked above.
	const isOpen = yield* Ref.make(true)
	const runOpen = runWith(symbols, conn as Pointer)
	// A query on a closed connection is a use-after-free in libchdb, so it fails instead.
	const run = (sql: string, format?: string) =>
		Effect.flatMap(Ref.get(isOpen), (stillOpen) =>
			stillOpen
				? runOpen(sql, format)
				: Effect.fail(new ParityChdbError({ message: "chDB is closed", sql })),
		)
	yield* Effect.forEach(SESSION_SETTINGS, (sql) => run(sql), { discard: true })
	const rows = (sql: string) =>
		run(sql, "JSONEachRow").pipe(
			Effect.flatMap((text) =>
				Effect.forEach(
					text.split("\n").filter((line) => line.length > 0),
					(line) =>
						decodeRow(line).pipe(
							Effect.mapError((cause) => new ParityChdbError({ message: cause.message, sql })),
						),
				),
			),
		)
	const close = Effect.flatMap(Ref.getAndSet(isOpen, false), (wasOpen) =>
		wasOpen ? Effect.sync(() => symbols.chdb_close_conn(connPtr)) : Effect.void,
	)
	const chdb: Chdb = { run, rows, dataDir, close }
	return chdb
})

/** The single connection, opened on first use and kept for the process lifetime. */
export const sharedChdb: Effect.Effect<Chdb, ParityChdbError> = Effect.runSync(Effect.cached(open))
