import { readRealFile, ensureLocalToken, localTokenMatches } from "../local-token"
// SAFETY-FILE: JSON rows here come from fixed internal formats and are validated before domain use.
import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Chdb } from "../chdb"
import { durableJson, durableRemove, durableRename, syncDirectory } from "../durable-files"
import { withMaintenanceLock } from "../checkpoints"
import { computeMultisetDigest, captureSourceSchema } from "./export"
import { assertCatalogExact, listActiveGenerations, rebuildCatalog, verifyActiveGeneration } from "./listing"
import { readArchiveGenerationManifest } from "./manifest"
import { ARCHIVE_SIGNALS, type ArchiveSignalName } from "./signals"
import {
	archiveRoot,
	assertNoSymlink,
	generationManifestPath,
	rangeRoot,
	shardsRoot,
	validateArchiveId,
	validateRangeDate,
	validateSealedRangeDate,
} from "./paths"
import { Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { decodeJsonSync, encodeJson } from "../json"

const decodeJsonRecord = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const LEDGER_FORMAT_VERSION = 1
const EXPIRATION_FORMAT_VERSION = 3
const SHA256 = /^[0-9a-f]{64}$/

export interface RetiredSignalEvidence {
	readonly signal: ArchiveSignalName
	readonly generationId: string
	readonly manifestSha256: string
	readonly archivedRowCount: number
	readonly contentDigest: string
}

export interface RetiredDayRecord {
	readonly rangeDate: string
	readonly retiredAt: string
	readonly signals: ReadonlyArray<RetiredSignalEvidence>
}

export interface RetiredDayLedger {
	readonly formatVersion: 1
	readonly retiredDays: ReadonlyArray<RetiredDayRecord>
}

interface ExpireOperation {
	readonly formatVersion: 3
	readonly operationId: string
	readonly rangeDate: string
	readonly completedSignals: ReadonlyArray<ArchiveSignalName>
	readonly removingSignal: ArchiveSignalName | null
	readonly archivedGenerations: Readonly<Record<ArchiveSignalName, string>>
}

type Db = Pick<Chdb, "query" | "exec">

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
	const expected = new Set(keys)
	for (const key of keys) if (!Rec.has(value, key)) throw new Error(`${label} is missing ${key}`)
	for (const key of Rec.keys(value))
		if (!expected.has(key)) throw new Error(`${label} has unknown field ${key}`)
}

const requiredString = (value: Record<string, unknown>, key: string, label: string): string => {
	const field = value[key]
	if (typeof field !== "string" || field.length === 0) throw new Error(`${label}.${key} must be a string`)
	return field
}

const requiredCount = (value: Record<string, unknown>, key: string, label: string): number => {
	const field = value[key]
	if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0)
		throw new Error(`${label}.${key} must be a non-negative safe integer`)
	return field
}

const parseSignalEvidence = (value: unknown): RetiredSignalEvidence => {
	if (!isRecord(value)) throw new Error("retired-day signal evidence must be a record")
	exactKeys(
		value,
		["signal", "generationId", "manifestSha256", "archivedRowCount", "contentDigest"],
		"retired-day signal evidence",
	)
	const signal = requiredString(value, "signal", "retired-day signal evidence")
	if (!Arr.some(ARCHIVE_SIGNALS, (candidate) => candidate.name === signal))
		throw new Error(`unknown retired-day signal: ${signal}`)
	const manifestSha256 = requiredString(value, "manifestSha256", "retired-day signal evidence")
	if (!SHA256.test(manifestSha256)) throw new Error("retired-day manifestSha256 must be lowercase SHA-256")
	const contentDigest = requiredString(value, "contentDigest", "retired-day signal evidence")
	if (!/^\d+:\d+:\d+:\d+$/.test(contentDigest))
		throw new Error("retired-day contentDigest must be a canonical bounded multiset digest")
	return {
		signal: signal as ArchiveSignalName,
		generationId: validateArchiveId(
			requiredString(value, "generationId", "retired-day signal evidence"),
			"retired-day generation",
		),
		manifestSha256,
		archivedRowCount: requiredCount(value, "archivedRowCount", "retired-day signal evidence"),
		contentDigest,
	}
}

const parseDayRecord = (value: unknown): RetiredDayRecord => {
	if (!isRecord(value)) throw new Error("retired-day record must be a record")
	exactKeys(value, ["rangeDate", "retiredAt", "signals"], "retired-day record")
	const signalsRaw = value.signals
	if (!Arr.isArray(signalsRaw)) throw new Error("retired-day signals must be an array")
	const signals = Arr.map(signalsRaw, parseSignalEvidence)
	const names = Arr.map(signals, (signal) => signal.signal)
	if (names.length !== ARCHIVE_SIGNALS.length || new Set(names).size !== ARCHIVE_SIGNALS.length)
		throw new Error("retired-day record must contain each raw signal exactly once")
	for (const [index, signal] of ARCHIVE_SIGNALS.entries())
		if (names[index] !== signal.name) throw new Error("retired-day signals are not in canonical order")
	const retiredAt = requiredString(value, "retiredAt", "retired-day record")
	const retiredMillis = Date.parse(retiredAt)
	if (Number.isNaN(retiredMillis) || new Date(retiredMillis).toISOString() !== retiredAt)
		throw new Error("retired-day retiredAt must be canonical ISO-8601")
	return {
		rangeDate: validateRangeDate(requiredString(value, "rangeDate", "retired-day record")),
		retiredAt,
		signals,
	}
}

export const parseRetiredDayLedger = (value: unknown): RetiredDayLedger => {
	if (!isRecord(value)) throw new Error("retired-day ledger must be a record")
	exactKeys(value, ["formatVersion", "retiredDays"], "retired-day ledger")
	if (value.formatVersion !== LEDGER_FORMAT_VERSION)
		throw new Error(`unsupported retired-day ledger formatVersion: ${String(value.formatVersion)}`)
	if (!Arr.isArray(value.retiredDays)) throw new Error("retired-day ledger retiredDays must be an array")
	const retiredDays = Arr.map(value.retiredDays, parseDayRecord)
	const dates = Arr.map(retiredDays, (day) => day.rangeDate)
	if (Arr.some(Arr.zip(dates, dates.slice(1)), ([previous, date]) => previous >= date))
		throw new Error("retired-day ledger dates must be unique and sorted")
	return { formatVersion: LEDGER_FORMAT_VERSION, retiredDays }
}

export const retiredDayLedgerPath = (dataDir: string): string => `${resolve(dataDir)}.retired-days.json`
export const maintenanceTokenPath = (dataDir: string): string => `${resolve(dataDir)}.maintenance-token`

export const readRetiredDayLedger = (dataDir: string): RetiredDayLedger => {
	const path = retiredDayLedgerPath(dataDir)
	if (!existsSync(path)) return { formatVersion: LEDGER_FORMAT_VERSION, retiredDays: [] }
	return parseRetiredDayLedger(decodeJsonSync(readRealFile(path, "retired-day ledger")))
}

export const ensureMaintenanceToken = (dataDir: string): Promise<string> =>
	ensureLocalToken(maintenanceTokenPath(dataDir), "maintenance token")
export const maintenanceTokenMatches = localTokenMatches

const eventDateKey: Readonly<Record<string, string>> = {
	traces: "start_time",
	logs: "timestamp",
	metrics_sum: "timestamp",
	metrics_gauge: "timestamp",
	metrics_histogram: "timestamp",
	metrics_exponential_histogram: "timestamp",
} satisfies Readonly<Record<string, string>>

export class RetiredDayAuthority {
	readonly #dataDir: string
	#ledger: RetiredDayLedger
	#dates: Set<string>

	constructor(dataDir: string) {
		this.#dataDir = dataDir
		this.#ledger = readRetiredDayLedger(dataDir)
		this.#dates = new Set(Arr.map(this.#ledger.retiredDays, (day) => day.rangeDate))
	}

	isRetired(rangeDate: string): boolean {
		return this.#dates.has(rangeDate)
	}

	hasRetiredDays(): boolean {
		return this.#dates.size > 0
	}

	record(rangeDate: string): RetiredDayRecord | undefined {
		return Option.getOrUndefined(
			Arr.findFirst(this.#ledger.retiredDays, (day) => day.rangeDate === rangeDate),
		)
	}

	assertBatchAllowed(datasource: string, ndjson: string): void {
		const filtered = this.filterBatch(datasource, ndjson)
		if (filtered.rejected > 0)
			throw new Error(`telemetry batch contains ${filtered.rejected} row(s) from a retired UTC day`)
	}

	filterBatch(
		datasource: string,
		ndjson: string,
	): { readonly ndjson: string; readonly accepted: number; readonly rejected: number } {
		const key = eventDateKey[datasource]
		if (!key) throw new Error(`unknown raw telemetry datasource: ${datasource}`)
		const accepted: string[] = []
		let rejected = 0
		for (const line of Str.split("\n")(ndjson)) {
			if (line.length === 0) continue
			const row = decodeJsonRecord(line)
			const timestamp = row[key]
			if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2} /.test(timestamp))
				throw new Error(`encoded ${datasource} row has no canonical UTC timestamp`)
			const rangeDate = Str.slice(0, 10)(timestamp)
			if (this.isRetired(rangeDate)) rejected++
			else accepted.push(line)
		}
		return { ndjson: Arr.join(accepted, "\n"), accepted: accepted.length, rejected }
	}

	async commit(record: RetiredDayRecord): Promise<void> {
		const parsed = parseDayRecord(record)
		const existing = this.record(parsed.rangeDate)
		if (existing) {
			if (encodeJson(existing) !== encodeJson(parsed))
				throw new Error(`retired-day evidence changed for ${parsed.rangeDate}`)
			return
		}
		const retiredDays = [...this.#ledger.retiredDays, parsed].sort((a, b) =>
			Str.localeCompare(b.rangeDate)(a.rangeDate),
		)
		const next = parseRetiredDayLedger({ formatVersion: LEDGER_FORMAT_VERSION, retiredDays })
		await durableJson(retiredDayLedgerPath(this.#dataDir), next)
		this.#ledger = next
		this.#dates.add(parsed.rangeDate)
	}

	replay(db: Db): void {
		removeRetiredDays(db, [...this.#dates])
	}

	replayDay(db: Db, rangeDate: string): void {
		if (!this.isRetired(rangeDate)) throw new Error(`UTC day ${rangeDate} is not retired`)
		removeUtcDay(db, rangeDate)
	}
}

const parseCount = (text: string, label: string): number => {
	const line = Arr.findFirst(Str.split("\n")(text), (candidate) => Str.trim(candidate).length > 0)
	const row: { readonly [key: string]: unknown } = Option.match(line, {
		onNone: () => ({}),
		onSome: (found) => decodeJsonRecord(found),
	})
	const count = Number(row.count ?? row["count()"] ?? 0)
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`invalid ${label} count`)
	return count
}

const liveCount = (db: Db, table: string, column: string, rangeDate: string): number =>
	parseCount(
		db.query(
			`SELECT count() AS count FROM ${table} WHERE toDate(${column}, 'UTC') = '${rangeDate}'`,
			"JSONEachRow",
		),
		`${table}/${rangeDate}`,
	)

const removeUtcDay = (db: Db, rangeDate: string): void => {
	for (const signal of ARCHIVE_SIGNALS) {
		db.exec(
			`ALTER TABLE ${signal.name} DELETE WHERE toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}' SETTINGS mutations_sync = 2`,
		)
		if (liveCount(db, signal.name, signal.eventTimeColumn, rangeDate) !== 0)
			throw new Error(`retired UTC day remains in ${signal.name}/${rangeDate}`)
	}
}

const sqlDates = (dates: readonly string[]): string =>
	Arr.join(
		Arr.map(dates, (date) => `'${date}'`),
		", ",
	)

/** Startup repair is bounded by table count, not ledger length. */
const removeRetiredDays = (db: Db, dates: readonly string[]): void => {
	if (dates.length === 0) return
	const allDates = sqlDates(dates)
	for (const signal of ARCHIVE_SIGNALS) {
		const rows = db.query(
			`SELECT DISTINCT toString(toDate(${signal.eventTimeColumn}, 'UTC')) AS rangeDate FROM ${signal.name} WHERE toDate(${signal.eventTimeColumn}, 'UTC') IN (${allDates})`,
			"JSONEachRow",
		)
		const present = Arr.filter(
			Arr.map(
				Arr.filter(Str.split("\n")(rows), (line) => Str.trim(line).length > 0),
				(line) => decodeJsonRecord(line).rangeDate,
			),
			(date): date is string => typeof date === "string" && dates.includes(date),
		)
		if (present.length === 0) continue
		db.exec(
			`ALTER TABLE ${signal.name} DELETE WHERE toDate(${signal.eventTimeColumn}, 'UTC') IN (${sqlDates(present)}) SETTINGS mutations_sync = 2`,
		)
		const remaining = parseCount(
			db.query(
				`SELECT count() AS count FROM ${signal.name} WHERE toDate(${signal.eventTimeColumn}, 'UTC') IN (${sqlDates(present)})`,
				"JSONEachRow",
			),
			`${signal.name}/retired-days`,
		)
		if (remaining !== 0) throw new Error(`retired UTC days remain in ${signal.name}`)
	}
}

export const assertSealedUtcDay = (range: string, sealingLagHours = 24, now = Date.now()): string => {
	return validateSealedRangeDate(range, sealingLagHours, now)
}

const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")
const safeSqlPath = (path: string): string => {
	if (Str.includes("'")(path) || Str.includes("\\")(path))
		throw new Error(`unsafe archive path for chDB: ${path}`)
	return path
}

const completeArchiveDay = (archiveDir: string, rangeDate: string) => {
	const listing = listActiveGenerations(archiveDir)
	const errors = Arr.filter(
		listing.errors,
		(error) => error.rangeStart === rangeDate || error.rangeStart === "",
	)
	if (errors.length > 0)
		throw new Error(
			`archive date ${rangeDate} is malformed: ${Arr.join(
				Arr.map(errors, (error) => error.error),
				"; ",
			)}`,
		)
	return Arr.map(ARCHIVE_SIGNALS, (signal) => {
		const matches = Arr.filter(
			listing.active,
			(generation) => generation.signal === signal.name && generation.rangeStart === rangeDate,
		)
		const [summary, ...extra] = matches
		if (summary === undefined || extra.length > 0)
			throw new Error(`archive date ${rangeDate} lacks one active ${signal.name} generation`)
		return { signal, summary }
	})
}

/**
 * Execute the destructive boundary inside the live server while ingest and
 * local queries are quiesced by the caller. The durable ledger is committed
 * before any DELETE. A crash after that boundary is repaired by startup replay;
 * a crash before it leaves all live data intact.
 */
export const retireLiveDayInServer = async (options: {
	readonly db: Db
	readonly authority: RetiredDayAuthority
	readonly archiveDir: string
	readonly rangeDate: string
	readonly sealingLagHours?: number
	readonly now?: number
}): Promise<RetiredDayRecord> => {
	const rangeDate = assertSealedUtcDay(
		options.rangeDate,
		options.sealingLagHours ?? 24,
		options.now ?? Date.now(),
	)
	const committed = options.authority.record(rangeDate)
	if (committed) {
		options.authority.replayDay(options.db, rangeDate)
		return committed
	}

	const complete = completeArchiveDay(options.archiveDir, rangeDate)
	const evidence: RetiredSignalEvidence[] = []
	for (const { signal, summary } of complete) {
		await verifyActiveGeneration(options.archiveDir, signal.name, rangeDate)
		const manifestPath = generationManifestPath(
			options.archiveDir,
			signal.name,
			rangeDate,
			summary.generationId,
		)
		const manifest = readArchiveGenerationManifest(
			options.archiveDir,
			signal.name,
			rangeDate,
			summary.generationId,
		)
		const count = liveCount(options.db, signal.name, signal.eventTimeColumn, rangeDate)
		if (count !== manifest.archivedRowCount)
			throw new Error(
				`refusing live retirement: ${signal.name}/${rangeDate} live=${count} archive=${manifest.archivedRowCount}`,
			)
		const schema = captureSourceSchema(options.db, signal)
		const liveDigest = computeMultisetDigest(
			options.db,
			schema,
			`${signal.name} WHERE toDate(${signal.eventTimeColumn}, 'UTC') = '${rangeDate}'`,
		)
		let archiveDigest = liveDigest
		if (manifest.archivedRowCount > 0) {
			const glob = safeSqlPath(
				join(
					shardsRoot(options.archiveDir, signal.name, rangeDate, summary.generationId),
					"*.parquet",
				),
			)
			archiveDigest = computeMultisetDigest(options.db, schema, `file('${glob}', Parquet)`)
		}
		if (liveDigest !== archiveDigest)
			throw new Error(`refusing live retirement: ${signal.name}/${rangeDate} content digest mismatch`)
		evidence.push({
			signal: signal.name,
			generationId: summary.generationId,
			manifestSha256: sha256File(manifestPath),
			archivedRowCount: manifest.archivedRowCount,
			contentDigest: archiveDigest,
		})
	}

	// Re-read identities and re-hash every shard immediately before the durable
	// commit. No destructive step can resume from stale verification evidence.
	for (const item of evidence) {
		await verifyActiveGeneration(options.archiveDir, item.signal, rangeDate)
		const current = Option.getOrThrow(
			Arr.findFirst(
				completeArchiveDay(options.archiveDir, rangeDate),
				(candidate) => candidate.signal.name === item.signal,
			),
		)
		if (current.summary.generationId !== item.generationId)
			throw new Error(
				`archive generation changed before retirement commit: ${item.signal}/${rangeDate}`,
			)
		const actualManifestSha = sha256File(
			generationManifestPath(options.archiveDir, item.signal, rangeDate, item.generationId),
		)
		if (actualManifestSha !== item.manifestSha256)
			throw new Error(`archive manifest changed before retirement commit: ${item.signal}/${rangeDate}`)
	}

	const record: RetiredDayRecord = {
		rangeDate,
		retiredAt: new Date(options.now ?? Date.now()).toISOString(),
		signals: evidence,
	}
	await options.authority.commit(record)
	removeUtcDay(options.db, rangeDate)
	return record
}

const expirationRecord = (archiveDir: string): string =>
	join(archiveRoot(archiveDir), ".retention", "expire.json")
const expirationTomb = (archiveDir: string, date: string, signal: string): string =>
	join(archiveRoot(archiveDir), ".retention", "expired", date, signal)

const parseExpireOperation = (value: unknown): ExpireOperation => {
	if (!isRecord(value)) throw new Error("archive expiration journal must be a record")
	exactKeys(
		value,
		[
			"formatVersion",
			"operationId",
			"rangeDate",
			"completedSignals",
			"removingSignal",
			"archivedGenerations",
		],
		"archive expiration journal",
	)
	if (value.formatVersion !== EXPIRATION_FORMAT_VERSION)
		throw new Error(`unsupported archive expiration journal version: ${String(value.formatVersion)}`)
	if (!Arr.isArray(value.completedSignals)) throw new Error("completedSignals must be an array")
	const completedSignals = Arr.map(value.completedSignals, (signal) => {
		if (
			typeof signal !== "string" ||
			!Arr.some(ARCHIVE_SIGNALS, (candidate) => candidate.name === signal)
		)
			throw new Error(`invalid completed signal: ${String(signal)}`)
		return signal as ArchiveSignalName
	})
	if (new Set(completedSignals).size !== completedSignals.length)
		throw new Error("completedSignals contains duplicates")
	for (const [index, signal] of completedSignals.entries())
		if (signal !== ARCHIVE_SIGNALS[index]?.name)
			throw new Error("completedSignals must be a canonical completed prefix")
	const removingSignal = value.removingSignal
	if (
		removingSignal !== null &&
		(typeof removingSignal !== "string" ||
			!Arr.some(ARCHIVE_SIGNALS, (candidate) => candidate.name === removingSignal))
	)
		throw new Error(`invalid removingSignal: ${encodeJson(removingSignal)}`)
	const expectedRemoving = ARCHIVE_SIGNALS[completedSignals.length]?.name ?? null
	if (removingSignal !== null && removingSignal !== expectedRemoving)
		throw new Error("removingSignal must be the next canonical signal")
	if (!isRecord(value.archivedGenerations)) throw new Error("archivedGenerations must be a record")
	exactKeys(
		value.archivedGenerations,
		Arr.map(ARCHIVE_SIGNALS, (signal) => signal.name),
		"archivedGenerations",
	)
	const archivedGenerations = Rec.fromEntries(
		Arr.map(ARCHIVE_SIGNALS, (signal) => [
			signal.name,
			validateArchiveId(
				requiredString(
					value.archivedGenerations as Record<string, unknown>,
					signal.name,
					"archivedGenerations",
				),
				"archive expiration generation",
			),
		]),
	) as Record<ArchiveSignalName, string>
	return {
		formatVersion: EXPIRATION_FORMAT_VERSION,
		operationId: validateArchiveId(
			requiredString(value, "operationId", "archive expiration journal"),
			"archive expiration operation",
		),
		rangeDate: validateRangeDate(requiredString(value, "rangeDate", "archive expiration journal")),
		completedSignals,
		removingSignal: removingSignal,
		archivedGenerations,
	}
}

const readExpireOperation = (path: string): ExpireOperation | null => {
	if (!existsSync(path)) return null
	return parseExpireOperation(decodeJsonSync(readRealFile(path, "archive expiration journal")))
}

/** Expire one already-retired archived UTC day. Resumes safely after interruption. */
export const expireArchiveDay = async (options: {
	readonly dataDir: string
	readonly archiveDir: string
	readonly scratchRoot: string
	readonly rangeDate: string
}): Promise<void> => {
	const rangeDate = validateRangeDate(options.rangeDate)
	await withMaintenanceLock(options.dataDir, randomUUID(), async () => {
		const { reconcileArchiveGeneration } = await import("./generation")
		await reconcileArchiveGeneration(options.dataDir, options.archiveDir, options.scratchRoot)
		const retired = Option.getOrUndefined(
			Arr.findFirst(
				readRetiredDayLedger(options.dataDir).retiredDays,
				(day) => day.rangeDate === rangeDate,
			),
		)
		if (!retired) throw new Error(`refusing archive expiration: UTC day ${rangeDate} is not retired`)
		const path = expirationRecord(options.archiveDir)
		let op = readExpireOperation(path)
		if (!op) {
			const complete = completeArchiveDay(options.archiveDir, rangeDate)
			for (const signal of ARCHIVE_SIGNALS) assertCatalogExact(options.archiveDir, signal.name)
			const archivedGenerations = Rec.fromEntries(
				Arr.map(complete, ({ signal, summary }) => [signal.name, summary.generationId]),
			) as Record<ArchiveSignalName, string>
			for (const item of retired.signals)
				if (archivedGenerations[item.signal] !== item.generationId)
					throw new Error(
						`active archive generation differs from retired authority: ${item.signal}/${rangeDate}`,
					)
			op = {
				formatVersion: EXPIRATION_FORMAT_VERSION,
				operationId: randomUUID(),
				rangeDate,
				completedSignals: [],
				removingSignal: null,
				archivedGenerations,
			}
			await durableJson(path, op)
		} else if (op.rangeDate !== rangeDate) {
			throw new Error(`unfinished archive expiration for ${op.rangeDate}`)
		}
		for (const signal of ARCHIVE_SIGNALS) {
			if (op.completedSignals.includes(signal.name)) continue
			if (op.removingSignal !== null && op.removingSignal !== signal.name)
				throw new Error(`archive expiration journal is out of canonical order at ${signal.name}`)
			const source = rangeRoot(options.archiveDir, signal.name, rangeDate)
			const tomb = expirationTomb(options.archiveDir, rangeDate, signal.name)
			await assertNoSymlink(archiveRoot(options.archiveDir), source, "archive expiration source")
			await assertNoSymlink(archiveRoot(options.archiveDir), tomb, "archive expiration tombstone")
			if (op.removingSignal === null && !existsSync(source))
				throw new Error(
					`archive expiration source vanished before durable removal intent: ${signal.name}/${rangeDate}`,
				)
			if (existsSync(source)) {
				const listing = listActiveGenerations(options.archiveDir)
				const relevantErrors = Arr.filter(
					listing.errors,
					(error) =>
						error.signal === signal.name &&
						(error.rangeStart === rangeDate || error.rangeStart === ""),
				)
				if (relevantErrors.length > 0)
					throw new Error(`archive became malformed during expiration: ${signal.name}/${rangeDate}`)
				const current = Arr.filter(
					listing.active,
					(candidate) => candidate.signal === signal.name && candidate.rangeStart === rangeDate,
				)
				const [only, ...others] = current
				if (
					only === undefined ||
					others.length > 0 ||
					only.generationId !== op.archivedGenerations[signal.name]
				)
					throw new Error(
						`archive generation changed after expiration intent: ${signal.name}/${rangeDate}`,
					)
				await verifyActiveGeneration(options.archiveDir, signal.name, rangeDate)
			}
			if (existsSync(source) && existsSync(tomb))
				throw new Error(
					`archive expiration has both source and tombstone: ${signal.name}/${rangeDate}`,
				)
			if (op.removingSignal === null) {
				op = { ...op, removingSignal: signal.name }
				await durableJson(path, op)
			}
			if (existsSync(source) && !existsSync(tomb)) {
				await mkdir(dirname(tomb), { recursive: true, mode: 0o700 })
				await durableRename(source, tomb)
			}
			if (existsSync(tomb)) {
				await rm(tomb, { recursive: true, force: true })
				await syncDirectory(dirname(tomb))
			}
			await rebuildCatalog(options.archiveDir, signal.name)
			op = {
				...op,
				completedSignals: [...op.completedSignals, signal.name],
				removingSignal: null,
			}
			await durableJson(path, op)
		}
		await durableRemove(path)
	})
}

export const retireLiveDay = async (options: {
	readonly dataDir: string
	readonly archiveDir: string
	readonly scratchRoot: string
	readonly rangeDate: string
	readonly port: number
	readonly sealingLagHours?: number
	readonly request?: typeof fetch
}): Promise<void> => {
	const rangeDate = assertSealedUtcDay(options.rangeDate, options.sealingLagHours ?? 24)
	await withMaintenanceLock(options.dataDir, randomUUID(), async () => {
		const { reconcileArchiveGeneration } = await import("./generation")
		await reconcileArchiveGeneration(options.dataDir, options.archiveDir, options.scratchRoot)
		const token = Str.trim(readRealFile(maintenanceTokenPath(options.dataDir), "maintenance token"))
		const request = options.request ?? fetch
		const response = await request(`http://127.0.0.1:${options.port}/local/retention/retire`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-maple-maintenance-token": token },
			body: encodeJson({
				archiveDir: resolve(options.archiveDir),
				rangeDate,
				sealingLagHours: options.sealingLagHours ?? 24,
			}),
		})
		if (!response.ok)
			throw new Error((await response.text().catch(() => "")) || `HTTP ${response.status}`)
	})
}
