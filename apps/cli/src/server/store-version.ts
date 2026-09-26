// Durable identity for a local chDB store.
//
// The short `schema` field is retained for compatibility with the original
// marker format.  It is a bundle identity, not proof that the physical store
// currently has that schema.  New markers carry a versioned identity and a
// stable store id; physical-schema checks are performed before a store is
// activated.

import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { Effect, Schema, SchemaGetter } from "effect"
import { CHDB_VERSION } from "../version"
import { Digest64, Fingerprint16, IsoOrUnknown } from "./identity-schema"
import { durableRemove, durableRenameSync, durableWrite, durableWriteFileSync } from "./durable-files"

export const STORE_MARKER_FORMAT_VERSION = 2 as const

export type StoreActivation = "active" | "staging"

export interface StoreMigrationStamp {
	readonly id: string
	readonly completedAt: string
	readonly fromVersion: number
	readonly toVersion: number
}

/** The v2 marker written by current Maple builds. */
export interface StoreMarkerV2 {
	readonly formatVersion: typeof STORE_MARKER_FORMAT_VERSION
	readonly storeId: string
	/** libchdb package/release identity that owns the on-disk format. */
	readonly chdb: string
	/** Maple version that first created the store. */
	readonly maple: string
	/** Immutable store creation timestamp. */
	readonly createdAt: string
	/** Immutable creator identity; useful when `maple` is a dev build. */
	readonly createdByMaple: string
	/** Monotonic local schema version. */
	readonly schemaVersion: number
	/** Full normalized bundled-schema digest. */
	readonly schemaDigest: string
	/** Legacy 16-character bundle fingerprint. */
	readonly schema: string
	/** A staged store is never eligible for ordinary startup. */
	readonly activation: StoreActivation
	readonly lastMigration?: StoreMigrationStamp
}

/** Marker shape written before v2. Keep this type explicit so callers can
 * distinguish an old marker from a current identity. */
export interface LegacyStoreMarker {
	readonly formatVersion: 1
	readonly chdb: string
	readonly maple: string
	readonly createdAt: string
	readonly schema: string
	readonly storeId?: undefined
	readonly schemaVersion?: undefined
	readonly schemaDigest?: undefined
	readonly activation?: undefined
}

export type StoreMarker = StoreMarkerV2 | LegacyStoreMarker

export type MarkerReadState =
	| { readonly kind: "missing" }
	| { readonly kind: "malformed"; readonly message: string }
	| { readonly kind: "valid"; readonly marker: StoreMarker }

/**
 * Per-data-dir state file beside the data dir. A dir named `data` keeps the
 * original bare names (`~/.maple/maple.pid`), so the default layout is
 * unchanged; any other dir prefixes its basename, so two stores that share a
 * parent (`~/.maple/data`, `~/.maple/data-b`) never share a sentinel or PID.
 */
export const dataDirSidecarPath = (dataDir: string, name: string): string => {
	const resolved = resolve(dataDir)
	const base = basename(resolved)
	return join(dirname(resolved), base === "data" ? name : `${base}.${name}`)
}

/** Where builds before {@link dataDirSidecarPath} kept `name` for this data dir. */
export const legacySidecarPath = (dataDir: string, name: string): string =>
	join(dirname(resolve(dataDir)), name)

/**
 * Whether bare-named files in the parent can belong to this data dir. For a
 * `data` dir they are its own current files; otherwise they are legacy ones
 * this dir owns unless a `data` sibling claims them under the current rule.
 */
export const ownsLegacySidecars = (dataDir: string): boolean => {
	const resolved = resolve(dataDir)
	return basename(resolved) !== "data" && !existsSync(join(dirname(resolved), "data"))
}

export const STORE_MARKER_NAME = "maple-store-version.json"
export const STORE_OPEN_MARKER_NAME = "maple-store-open"
export const MIGRATION_JOURNAL_NAME = "maple-store-migration.json"
export const SERVER_PID_NAME = "maple.pid"

/** The `maple start` PID file for a data dir (e.g. `~/.maple/maple.pid`). */
export const serverPidPath = (dataDir: string): string => dataDirSidecarPath(dataDir, SERVER_PID_NAME)

/** Written once a server is listening, removed on clean shutdown:
 * `{pid, url, dataDir, startedAt}` so other CLI processes can find it. */
export const serverDiscoveryPath = (dataDir: string): string =>
	dataDirSidecarPath(dataDir, "maple-server.json")

/** Path to the marker for a given data dir (beside it, like the PID file). */
export const storeMarkerPath = (dataDir: string): string => dataDirSidecarPath(dataDir, STORE_MARKER_NAME)

/** True once chDB has bootstrapped a store here (it creates `store/`/`metadata/`). */
export const storeHasData = (dataDir: string): boolean =>
	existsSync(join(dataDir, "store")) || existsSync(join(dataDir, "metadata"))

const pidFileNamesLiveProcess = (path: string): boolean =>
	Effect.runSync(
		Effect.try({
			try: () => {
				const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
				if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false
				process.kill(pid, 0)
				return true
			},
			// EPERM still means the PID exists; only a vanished file or ESRCH is "not live".
			catch: (error) => error,
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					typeof error === "object" && error !== null && "code" in error && error.code === "EPERM",
				),
			),
		),
	)

/**
 * Move this store's identity files from their pre-{@link dataDirSidecarPath}
 * location, so upgrading never strands a custom `--data-dir` store as
 * unversioned or clean-when-dirty. Only for a populated store that has no
 * current-layout marker yet (so it runs once), when ownership is unambiguous
 * (see {@link ownsLegacySidecars}) and no older server still runs from the
 * legacy PID file. Returns the names it moved.
 */
export const adoptLegacySidecars = (dataDir: string): ReadonlyArray<string> => {
	if (!ownsLegacySidecars(dataDir) || !storeHasData(dataDir)) return []
	if (existsSync(storeMarkerPath(dataDir))) return []
	if (pidFileNamesLiveProcess(legacySidecarPath(dataDir, SERVER_PID_NAME))) return []
	const adopted: Array<string> = []
	for (const name of [STORE_MARKER_NAME, STORE_OPEN_MARKER_NAME, MIGRATION_JOURNAL_NAME]) {
		const from = legacySidecarPath(dataDir, name)
		const to = dataDirSidecarPath(dataDir, name)
		if (!existsSync(from) || existsSync(to)) continue
		durableRenameSync(from, to)
		adopted.push(name)
	}
	return adopted
}

// Every "what state is this store in" read adopts first, so callers that never
// pass through `maple start` (schema, archive) see the same files it does.
const adoptLegacySidecarsQuietly = (dataDir: string): void =>
	Effect.runSync(
		Effect.try({ try: () => adoptLegacySidecars(dataDir), catch: (error) => error }).pipe(Effect.ignore),
	)

/**
 * Store schema version recorded by a NEWER maple than this build, if any. Such
 * a store is not stale: a downgrade wrote nothing, so the fix is reinstalling
 * the newer build, never a reset.
 */
export const newerStoreSchemaVersion = (dataDir: string, currentVersion: number): number | undefined => {
	if (!storeHasData(dataDir)) return undefined
	const marker = readMarker(dataDir)
	return marker?.formatVersion === STORE_MARKER_FORMAT_VERSION && marker.schemaVersion > currentVersion
		? marker.schemaVersion
		: undefined
}

/** Modification time of a file in ms, or undefined when it is missing. */
export const fileModifiedAtMs = (path: string): number | undefined =>
	Effect.runSync(
		Effect.try({ try: () => statSync(path).mtimeMs, catch: (error) => error }).pipe(
			Effect.orElseSucceed(() => undefined),
		),
	)

// Clean-shutdown sentinel. Present from the moment chDB opens successfully until
// it closes cleanly. It is deliberately separate from the migration journal:
// a staged target must never look like an active store.

/** Path to the clean-shutdown sentinel for a given data dir (beside it). */
export const storeOpenMarkerPath = (dataDir: string): string =>
	dataDirSidecarPath(dataDir, STORE_OPEN_MARKER_NAME)

/** Mark the store as open (not yet cleanly closed). Durable: a power loss right
 * after chDB opens must still leave the store reading as dirty. */
export const markStoreOpen = (dataDir: string): void => {
	durableWriteFileSync(storeOpenMarkerPath(dataDir), `${process.pid}\n`)
}

/** Durable variant used by migration connections. A migration may open a
 * store many times and must leave evidence even if the process dies during
 * chDB connect/bootstrap, before the connection can be closed normally. */
export const markStoreOpenDurable = async (dataDir: string): Promise<void> => {
	await durableWrite(storeOpenMarkerPath(dataDir), `${process.pid}\n`)
}

/** Clear the clean-shutdown sentinel. Best effort: a missing marker is fine. */
export const markStoreClosed = (dataDir: string): void => {
	try {
		unlinkSync(storeOpenMarkerPath(dataDir))
	} catch {
		// already gone, nothing to clear
	}
}

/** Durably clear the clean-shutdown sentinel for a restore transaction. */
export const markStoreClosedDurable = async (dataDir: string): Promise<void> => {
	const path = storeOpenMarkerPath(dataDir)
	if (existsSync(path)) await durableRemove(path)
}

/** True when the store holds data and was not cleanly closed. */
export const isStoreDirty = (dataDir: string): boolean => {
	adoptLegacySidecarsQuietly(dataDir)
	return storeHasData(dataDir) && existsSync(storeOpenMarkerPath(dataDir))
}

/**
 * Provenance fields are read leniently.
 *
 * `maple`, `createdAt`, and `createdByMaple` describe who made the store, not
 * what it contains. A store whose provenance is missing or garbled is still a
 * perfectly openable store, so a bad value degrades to "unknown" instead of
 * making the marker malformed and refusing to start. Everything below this
 * comment (the identity fields the loader actually acts on) is strict.
 */
const LenientProvenance = Schema.Unknown.pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.transform((value) => (typeof value === "string" ? value : "unknown")),
		encode: SchemaGetter.passthrough(),
	}),
	Schema.withDecodingDefaultKey(Effect.succeed(undefined)),
)

const StoreMigrationStampSchema = Schema.Struct({
	id: Schema.String,
	completedAt: IsoOrUnknown,
	fromVersion: Schema.Int,
	toVersion: Schema.Int,
})

const StoreMarkerV2Schema = Schema.Struct({
	formatVersion: Schema.Literal(STORE_MARKER_FORMAT_VERSION),
	storeId: Schema.String.check(Schema.isMinLength(1)),
	chdb: Schema.String.check(Schema.isMinLength(1)),
	maple: LenientProvenance,
	createdAt: LenientProvenance.check(
		Schema.makeFilter((value: string) =>
			value === "unknown" || Number.isFinite(Date.parse(value))
				? undefined
				: "marker createdAt is invalid",
		),
	),
	createdByMaple: LenientProvenance,
	schemaVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	schemaDigest: Digest64,
	schema: Fingerprint16,
	activation: Schema.Literals(["active", "staging"]),
	lastMigration: Schema.optionalKey(StoreMigrationStampSchema),
})

/**
 * The original marker had no `formatVersion` at all, so v1 is recognised by its
 * absence. A malformed object must not silently become a legacy store, which is
 * why `chdb` stays required here: it is the only field the original format
 * guaranteed.
 */
const StoreMarkerV1Schema = Schema.Struct({
	formatVersion: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
	chdb: Schema.String.check(Schema.isMinLength(1)),
	maple: LenientProvenance,
	createdAt: LenientProvenance.check(
		Schema.makeFilter((value: string) =>
			value === "unknown" || Number.isFinite(Date.parse(value))
				? undefined
				: "marker createdAt is invalid",
		),
	),
	schema: Schema.Unknown.pipe(
		Schema.decodeTo(Schema.String, {
			decode: SchemaGetter.transform((value) => (typeof value === "string" ? value : "")),
			encode: SchemaGetter.passthrough(),
		}),
		Schema.withDecodingDefaultKey(Effect.succeed(undefined)),
	),
})

const decodeMarkerV1 = Schema.decodeUnknownSync(StoreMarkerV1Schema)
const decodeMarkerV2 = Schema.decodeUnknownSync(StoreMarkerV2Schema)

const parseMarker = (value: unknown): StoreMarker => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("marker must contain a non-empty chdb string")
	}
	const formatVersion = (value as { readonly formatVersion?: unknown }).formatVersion
	if (formatVersion !== undefined && formatVersion !== 1 && formatVersion !== STORE_MARKER_FORMAT_VERSION) {
		throw new Error(`unsupported marker format ${String(formatVersion)}`)
	}
	if (formatVersion === STORE_MARKER_FORMAT_VERSION) {
		const marker = decodeMarkerV2(value)
		// The one default a struct cannot express: an unrecorded creator is the
		// running version, not "unknown".
		return marker.createdByMaple === "unknown" ? { ...marker, createdByMaple: marker.maple } : marker
	}
	return decodeMarkerV1(value)
}

/** Read the marker with an explicit missing/malformed distinction. */
export const readMarkerState = (dataDir: string): MarkerReadState => {
	adoptLegacySidecarsQuietly(dataDir)
	const path = storeMarkerPath(dataDir)
	if (!existsSync(path)) return { kind: "missing" }
	try {
		return { kind: "valid", marker: parseMarker(JSON.parse(readFileSync(path, "utf8")) as unknown) }
	} catch (error) {
		return { kind: "malformed", message: error instanceof Error ? error.message : String(error) }
	}
}

/** Read a marker, or null when missing/unparseable (legacy API). */
export const readMarker = (dataDir: string): StoreMarker | null => {
	const result = readMarkerState(dataDir)
	return result.kind === "valid" ? result.marker : null
}

export interface StoreMarkerWriteOptions {
	readonly storeId?: string
	readonly createdAt?: string
	readonly createdByMaple?: string
	readonly schemaVersion?: number
	readonly schemaDigest?: string
	readonly activation?: StoreActivation
	readonly lastMigration?: StoreMigrationStamp
}

/** Construct a v2 marker. The caller may provide a stable store id when
 * creating a target or upgrading a legacy marker. */
export const makeStoreMarker = (
	maple: string,
	now: string,
	schema: string,
	options: StoreMarkerWriteOptions = {},
): StoreMarkerV2 => {
	if (options.schemaVersion === undefined) {
		throw new Error("a schemaVersion is required for a v2 marker")
	}
	// Constructing through the same schema the reader decodes with is the point:
	// the fingerprint and digest rules are stated once, and a marker this build
	// writes is a marker this build can read back.
	return decodeMarkerV2({
		formatVersion: STORE_MARKER_FORMAT_VERSION,
		storeId: options.storeId ?? randomUUID(),
		chdb: CHDB_VERSION,
		maple,
		createdAt: options.createdAt ?? now,
		createdByMaple: options.createdByMaple ?? maple,
		schemaVersion: options.schemaVersion,
		schemaDigest: options.schemaDigest,
		schema,
		activation: options.activation ?? "active",
		...(!(options.lastMigration === undefined) ? { lastMigration: options.lastMigration } : undefined),
	})
}

/** Upgrade a legacy marker or create a new marker, preserving immutable
 * provenance when it already exists. */
export const ensureStoreMarkerDurable = async (
	dataDir: string,
	identity: { readonly version: number; readonly digest: string; readonly fingerprint: string },
	maple: string,
	now = new Date().toISOString(),
	options: Pick<StoreMarkerWriteOptions, "activation" | "lastMigration" | "storeId"> = {},
): Promise<StoreMarkerV2> => {
	const existing = readMarker(dataDir)
	if (existing?.formatVersion === STORE_MARKER_FORMAT_VERSION) {
		if (options.storeId !== undefined && existing.storeId !== options.storeId) {
			throw new Error(
				`store marker identity mismatch: expected store ${options.storeId}, found ${existing.storeId}`,
			)
		}
		if (
			existing.activation === "staging" &&
			options.activation !== "active" &&
			existing.storeId === (options.storeId ?? existing.storeId) &&
			existing.schemaVersion === identity.version &&
			existing.schemaDigest === identity.digest &&
			existing.schema === identity.fingerprint
		) {
			return existing
		}
		const updated: StoreMarkerV2 = {
			...existing,
			schemaVersion: identity.version,
			schemaDigest: identity.digest,
			schema: identity.fingerprint,
			activation: options.activation ?? existing.activation,
			...(!(options.lastMigration === undefined)
				? { lastMigration: options.lastMigration }
				: undefined),
		}
		await durableWrite(storeMarkerPath(dataDir), `${JSON.stringify(updated, null, 2)}\n`)
		return updated
	}

	const created = makeStoreMarker(maple, now, identity.fingerprint, {
		...identity,
		schemaVersion: identity.version,
		schemaDigest: identity.digest,
		createdAt: existing?.createdAt !== undefined ? existing.createdAt : now,
		createdByMaple: existing?.maple,
		storeId: options.storeId ?? existing?.storeId,
		activation: options.activation,
		lastMigration: options.lastMigration,
	})
	await durableWrite(storeMarkerPath(dataDir), `${JSON.stringify(created, null, 2)}\n`)
	return created
}

/** Durable writer used by checkpoint restore. It preserves the existing store
 * id and creation timestamp rather than rewriting them. */
export const writeStoreMarkerDurable = async (
	dataDir: string,
	maple: string,
	now: string,
	schema: string,
	options: StoreMarkerWriteOptions & {
		readonly schemaVersion: number
		readonly schemaDigest: string
	},
): Promise<void> => {
	await ensureStoreMarkerDurable(
		dataDir,
		{
			version: options.schemaVersion,
			digest: options.schemaDigest,
			fingerprint: schema,
		},
		maple,
		now,
		options,
	)
}

/** Stable normalized bundled-schema text used by both the legacy short
 * fingerprint and the v2 full digest. This is intentionally not described as
 * a physical-schema hash: regex normalization cannot parse SQL literals. */
export const normalizedSchemaSql = (schemaSql: string): string =>
	schemaSql
		.replace(/--[^\n]*/g, "")
		.replace(/\s+/g, " ")
		.trim()

export const schemaDigest = (schemaSql: string): string =>
	createHash("sha256").update(normalizedSchemaSql(schemaSql)).digest("hex")

/** Legacy bundle fingerprint retained for compatibility and diagnostics. */
export const schemaFingerprint = (schemaSql: string): string => schemaDigest(schemaSql).slice(0, 16)

/** True when a populated store was bootstrapped from a different schema
 * identity. The caller must choose migration or explicit reset. */
export const isSchemaIdentityStale = (
	dataDir: string,
	identity: { readonly version: number; readonly digest: string; readonly fingerprint: string },
): boolean => {
	if (!storeHasData(dataDir)) return false
	const marker = readMarker(dataDir)
	if (marker === null) return true
	if (marker.formatVersion === STORE_MARKER_FORMAT_VERSION) {
		return (
			marker.schemaVersion !== identity.version ||
			marker.schemaDigest !== identity.digest ||
			marker.schema !== identity.fingerprint
		)
	}
	return marker.schema !== identity.fingerprint
}

export type StoreCompatibility =
	| { readonly compatible: true }
	| { readonly compatible: false; readonly found: string; readonly current: string }

/** Decide whether the current libchdb may open the store at `dataDir`. */
export const checkStoreCompatible = (dataDir: string): StoreCompatibility => {
	if (!storeHasData(dataDir)) return { compatible: true }
	const state = readMarkerState(dataDir)
	if (state.kind === "missing") {
		return { compatible: false, found: "an unversioned legacy store", current: CHDB_VERSION }
	}
	if (state.kind === "malformed") {
		return { compatible: false, found: "a malformed store marker", current: CHDB_VERSION }
	}
	if (state.marker.chdb !== CHDB_VERSION) {
		return { compatible: false, found: state.marker.chdb, current: CHDB_VERSION }
	}
	if (state.marker.formatVersion === STORE_MARKER_FORMAT_VERSION && state.marker.activation !== "active") {
		return { compatible: false, found: "a staged/incomplete store", current: "an active store" }
	}
	return { compatible: true }
}
