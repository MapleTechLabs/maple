/**
 * Schema-apply workflow body, run by the alchemy Workflow class in
 * `./ClickHouseSchemaApplyWorkflow.ts`, which provides `Database` over one
 * Postgres connection per run and the run's own telemetry.
 *
 * Runs Maple's ClickHouse migrations against a customer's BYO cluster, splitting
 * each backfill into day-window chunks (one durable step each) so no single
 * statement exceeds the Worker subrequest budget. Mirrors the bookkeeping in
 * `OrgClickHouseSettingsService`/`@maple/clickhouse-cli` (`_maple_schema_migrations`)
 * and writes UI progress to `org_clickhouse_schema_apply_runs`.
 *
 * Clocks are read inside steps only: the body replays, and a clock read there
 * would differ on every replay.
 */
import { createDecipheriv } from "node:crypto"
import { orgClickHouseSchemaApplyRuns, orgClickHouseSettings } from "@maple/db"
import {
	clickHouseSchemaVersion,
	clickHouseSchemaFeatures,
	computeSchemaDiff,
	expandMigrationToSteps,
	extractColumnDefinition,
	featureSupportedByVersion,
	migrations as clickHouseMigrations,
	parseEmittedStatement,
	performanceOnlySearchColumns,
	qualifyStatementForDatabase,
	type ActualTable,
	type ApplyStep,
	type DesiredTable,
} from "@maple/domain/clickhouse"
import { OrgId } from "@maple/domain/http"
import * as Cloudflare from "alchemy/Cloudflare"
import { eq } from "drizzle-orm"
import { Cause, Clock, Effect, Layer, Option, Schema } from "effect"
import { EdgeCacheService } from "@maple/cache"
import { CacheBackendLive } from "@/platform/CacheBackendLive"
import { Database, type DatabaseApi, type DatabaseError } from "@/platform/DatabaseLive"
import { msToDate } from "@/platform/time"
import {
	invalidateOrgRuntimeConfigMemo,
	ORG_CH_CONFIG_CACHE_BUCKET,
} from "@/services/org/OrgClickHouseSettingsService"
import { durableStep, type DurableStepConfig } from "./durable-step"

/**
 * Bust the cached runtime config after the workflow writes to
 * `org_clickhouse_settings` (it stamps `schema_version`, part of the cached
 * projection).
 *
 * Both tiers. The memo call is isolate-local and therefore almost decorative
 * here — the workflow runs in its own isolate, so it clears a memo no API
 * request will ever read — but the shared edge-cache entry is the one that
 * matters: it is what every API isolate reads on a memo miss, and at a 6h TTL
 * it would otherwise hand back the pre-apply `schema_version` (and so a wrong
 * `clickhouse.schemaDrift`) for the rest of the day.
 *
 * Best-effort by design: `invalidate` already swallows backend failures, and
 * `Effect.ignore` covers the case where this isolate has no Cache API at all.
 * A missed eviction costs an annotation, never a routing decision.
 */
const bustRuntimeConfigCache = (orgId: OrgId): Effect.Effect<void> =>
	Effect.gen(function* () {
		invalidateOrgRuntimeConfigMemo(orgId)
		const cache = yield* EdgeCacheService
		yield* cache.invalidate({ bucket: ORG_CH_CONFIG_CACHE_BUCKET, key: orgId })
	}).pipe(
		// The workflow isolate has no application runtime to own this cache layer.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))),
		Effect.ignore,
	)

export interface SchemaApplyWorkflowPayload {
	readonly orgId: string
}

export interface SchemaApplyWorkflowResult {
	readonly status: "succeeded" | "failed"
	readonly appliedVersions: ReadonlyArray<number>
}

/** The one secret the run needs, read off alchemy's untyped Worker env. */
const SchemaApplyEnv = Schema.Struct({ MAPLE_INGEST_KEY_ENCRYPTION_KEY: Schema.String })

interface LoadOptionalFeatureStateOptions<R> {
	readonly ensureBookkeeping: Effect.Effect<void, unknown, R>
	readonly readServerVersion: Effect.Effect<string, unknown, R>
	readonly readAppliedFeatureRevisions: Effect.Effect<ReadonlyMap<string, number>, unknown, R>
}

export type OptionalFeatureState =
	| {
			readonly available: true
			readonly serverVersion: string
			readonly appliedFeatureRevisions: ReadonlyMap<string, number>
	  }
	| { readonly available: false; readonly reason: string }

/**
 * A durable step that failed surfaces as a defect (its retries are spent), so
 * the reason is read off the whole cause, not the typed error channel.
 */
const causeMessage = (cause: Cause.Cause<unknown>): string => {
	const error = Cause.squash(cause)
	return error instanceof Error ? error.message : String(error)
}

/**
 * Optional feature metadata must never decide whether the correctness schema
 * is ready for ingest. Keeping this boundary explicit also makes the workflow
 * policy testable without a live durable-workflow runtime.
 */
export const loadOptionalFeatureState = <R>(
	options: LoadOptionalFeatureStateOptions<R>,
): Effect.Effect<OptionalFeatureState, never, R> =>
	Effect.gen(function* () {
		yield* options.ensureBookkeeping
		const serverVersion = yield* options.readServerVersion
		const appliedFeatureRevisions = yield* options.readAppliedFeatureRevisions
		const state: OptionalFeatureState = { available: true, serverVersion, appliedFeatureRevisions }
		return state
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.succeed<OptionalFeatureState>({ available: false, reason: causeMessage(cause) }),
		),
	)

const STEP: DurableStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } }

// --- ClickHouse exec --------------------------------------------------------

interface ChConfig {
	readonly url: string
	readonly user: string
	readonly password: string
	readonly database: string
}

/** A ClickHouse HTTP call that did not return 2xx; `status` is absent when the request never completed. */
export class ClickHouseExecError extends Schema.TaggedError<ClickHouseExecError>()(
	"@maple/api/workflows/ClickHouseExecError",
	{ status: Schema.optionalKey(Schema.Number), message: Schema.String },
) {}

const toClickHouseExecError = (cause: unknown): ClickHouseExecError =>
	cause instanceof ClickHouseExecError
		? cause
		: new ClickHouseExecError({ message: cause instanceof Error ? cause.message : String(cause) })

/**
 * The one ClickHouse HTTP implementation, Promise-shaped because
 * `expandMigrationToSteps` takes a Promise `exec`; `execClickHouse` lifts it.
 */
const execClickHousePromise = (cfg: ChConfig, sql: string): Promise<string> => {
	const url = `${cfg.url.replace(/\/$/, "")}/?database=${encodeURIComponent(cfg.database)}`
	const headers = new Headers({
		"Content-Type": "text/plain",
		"X-ClickHouse-User": cfg.user,
		"X-ClickHouse-Database": cfg.database,
	})
	if (cfg.password.length > 0) headers.set("X-ClickHouse-Key", cfg.password)
	return fetch(url, { method: "POST", headers, body: sql, redirect: "manual" }).then((response) =>
		response.text().then((text) => {
			if (response.status >= 300 && response.status < 400) {
				return Promise.reject(
					new ClickHouseExecError({
						status: response.status,
						message: `ClickHouse redirect responses are not allowed (${response.status})`,
					}),
				)
			}
			if (!response.ok) {
				return Promise.reject(
					new ClickHouseExecError({
						status: response.status,
						message: `ClickHouse ${response.status}: ${text.split("\n")[0]?.slice(0, 500) ?? ""}`,
					}),
				)
			}
			return text
		}),
	)
}

const execClickHouse = (cfg: ChConfig, sql: string): Effect.Effect<string, ClickHouseExecError> =>
	Effect.tryPromise({ try: () => execClickHousePromise(cfg, sql), catch: toClickHouseExecError })

const planMigrationSteps = (
	cfg: ChConfig,
	migration: (typeof clickHouseMigrations)[number],
): Effect.Effect<ReadonlyArray<ApplyStep>, ClickHouseExecError> =>
	Effect.tryPromise({
		try: () => expandMigrationToSteps(migration, cfg.database, (sql) => execClickHousePromise(cfg, sql)),
		catch: toClickHouseExecError,
	})

/**
 * The queries are ours and ask for JSONEachRow, so a line that does not decode
 * is a warning or a blank the server interleaved — skip it.
 */
const parseJsonEachRow = <S extends Schema.ConstraintDecoder<unknown>>(rowSchema: S) => {
	const decodeRow = Schema.decodeUnknownOption(Schema.fromJsonString(rowSchema))
	return (text: string): ReadonlyArray<S["Type"]> => {
		const out: Array<S["Type"]> = []
		for (const line of text.split("\n")) {
			const trimmed = line.trim()
			if (trimmed.length === 0) continue
			const row = decodeRow(trimmed)
			if (Option.isSome(row)) out.push(row.value)
		}
		return out
	}
}

/** ClickHouse quotes UInt64 on the JSON wire; small counters arrive either way. */
const WireNumber = Schema.Union([Schema.Number, Schema.NumberFromString])

const parseVersionRows = parseJsonEachRow(Schema.Struct({ version: WireNumber }))
const parseFeatureRevisionRows = parseJsonEachRow(Schema.Struct({ id: Schema.String, revision: WireNumber }))
const parseTableRows = parseJsonEachRow(Schema.Struct({ name: Schema.String, engine: Schema.String }))
const parseColumnRows = parseJsonEachRow(
	Schema.Struct({ table: Schema.String, name: Schema.String, type: Schema.String }),
)
const parseSortingKeyRows = parseJsonEachRow(
	Schema.Struct({ sorting_key: Schema.optionalKey(Schema.String) }),
)

// --- migration bookkeeping (mirrors the service + CLI) ----------------------

const MIGRATIONS_TABLE = "_maple_schema_migrations"
const FEATURES_TABLE = "_maple_schema_features"
const quote = (name: string): string => `\`${name.replace(/`/g, "``")}\``

const ensureMigrationsTable = (cfg: ChConfig) =>
	execClickHouse(
		cfg,
		`CREATE TABLE IF NOT EXISTS ${quote(MIGRATIONS_TABLE)} (version UInt32, applied_at DateTime64(3) DEFAULT now64(3), description String) ENGINE = MergeTree ORDER BY version`,
	).pipe(Effect.asVoid)

const ensureFeaturesTable = (cfg: ChConfig) =>
	execClickHouse(
		cfg,
		`CREATE TABLE IF NOT EXISTS ${quote(FEATURES_TABLE)} (
  id String,
  revision UInt32,
  applied_at DateTime64(3) DEFAULT now64(3),
  description String
) ENGINE = ReplacingMergeTree(revision) ORDER BY id`,
	).pipe(Effect.asVoid)

const readAppliedVersions = (cfg: ChConfig): Effect.Effect<ReadonlyArray<number>, ClickHouseExecError> =>
	execClickHouse(cfg, `SELECT version FROM ${quote(MIGRATIONS_TABLE)} FORMAT JSONEachRow`).pipe(
		Effect.map((text) => [...new Set(parseVersionRows(text).map((r) => r.version))]),
	)

const recordVersion = (cfg: ChConfig, version: number, description: string) =>
	execClickHouse(
		cfg,
		`INSERT INTO ${quote(MIGRATIONS_TABLE)} (version, description) VALUES (${version}, '${description.replace(/'/g, "''")}')`,
	).pipe(Effect.asVoid)

/** Entries rather than a Map: a step's value must survive Cloudflare's JSON persistence. */
const readAppliedFeatureRevisions = (
	cfg: ChConfig,
): Effect.Effect<ReadonlyArray<readonly [string, number]>, ClickHouseExecError> =>
	execClickHouse(
		cfg,
		`SELECT id, max(revision) AS revision FROM ${quote(FEATURES_TABLE)} GROUP BY id FORMAT JSONEachRow`,
	).pipe(Effect.map((text) => parseFeatureRevisionRows(text).map((row) => [row.id, row.revision] as const)))

const recordFeature = (cfg: ChConfig, id: string, revision: number, description: string) =>
	execClickHouse(
		cfg,
		`INSERT INTO ${quote(FEATURES_TABLE)} (id, revision, description) VALUES ('${id.replace(/'/g, "''")}', ${revision}, '${description.replace(/'/g, "''")}')`,
	).pipe(Effect.asVoid)

const normalizeExpression = (value: string): string =>
	value.replace(/`/g, "").replace(/\s+/g, "").toLowerCase()

// --- config load + decrypt (mirror of the service helper) -------------------

/** A settings row that cannot be turned into a usable ClickHouse target. */
export class SchemaApplyConfigError extends Schema.TaggedError<SchemaApplyConfigError>()(
	"@maple/api/workflows/SchemaApplyConfigError",
	{ message: Schema.String },
) {}

const decryptPassword = (
	encryptionKey: Buffer,
	ciphertext: string,
	iv: string,
	tag: string,
): Effect.Effect<string, SchemaApplyConfigError> =>
	Effect.try({
		try: () => {
			const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64"))
			decipher.setAuthTag(Buffer.from(tag, "base64"))
			return Buffer.concat([
				decipher.update(Buffer.from(ciphertext, "base64")),
				decipher.final(),
			]).toString("utf8")
		},
		catch: (cause) =>
			new SchemaApplyConfigError({
				message: `Stored ClickHouse password could not be decrypted: ${cause instanceof Error ? cause.message : String(cause)}`,
			}),
	})

const loadConfig = (
	database: DatabaseApi,
	orgId: OrgId,
	encryptionKey: Buffer,
): Effect.Effect<ChConfig, SchemaApplyConfigError | DatabaseError> =>
	Effect.gen(function* () {
		const rows = yield* database.execute((db) =>
			db.select().from(orgClickHouseSettings).where(eq(orgClickHouseSettings.orgId, orgId)).limit(1),
		)
		const row = rows[0]
		if (!row) {
			return yield* new SchemaApplyConfigError({
				message: `No ClickHouse settings configured for org ${orgId}`,
			})
		}
		const password =
			row.chPasswordCiphertext && row.chPasswordIv && row.chPasswordTag
				? yield* decryptPassword(
						encryptionKey,
						row.chPasswordCiphertext,
						row.chPasswordIv,
						row.chPasswordTag,
					)
				: ""
		const parsedUrl = yield* Effect.try({
			try: () => new URL(row.chUrl),
			catch: () => new SchemaApplyConfigError({ message: "Stored ClickHouse URL is invalid" }),
		})
		if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
			return yield* new SchemaApplyConfigError({
				message: "Stored ClickHouse credentials must not be embedded in the URL",
			})
		}
		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
			return yield* new SchemaApplyConfigError({
				message: "Stored ClickHouse URL must use HTTP or HTTPS",
			})
		}
		if (password.length > 0 && parsedUrl.protocol !== "https:") {
			return yield* new SchemaApplyConfigError({
				message: "Stored ClickHouse URL must use HTTPS when a password is configured",
			})
		}
		return { url: row.chUrl, user: row.chUser, password, database: row.chDatabase }
	})

// --- run-row progress (org_clickhouse_schema_apply_runs) --------------------

type RunPatch = Partial<{
	status: "queued" | "running" | "succeeded" | "failed"
	phase: string | null
	currentMigration: number | null
	stepsTotal: number | null
	stepsDone: number | null
	appliedVersions: ReadonlyArray<number> | null
	skipped: unknown
	errorMessage: string | null
	startedAt: Date | null
	finishedAt: Date | null
}>

/** Stamps `updatedAt` from the clock, so it only ever runs inside a step (or on the failure path). */
const updateRun = (database: DatabaseApi, orgId: OrgId, patch: RunPatch) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		yield* database.execute((db) =>
			db
				.update(orgClickHouseSchemaApplyRuns)
				.set({ ...patch, updatedAt: msToDate(now) })
				.where(eq(orgClickHouseSchemaApplyRuns.orgId, orgId)),
		)
	})

// --- snapshot-diff additive (mirror of OrgClickHouseSettingsService) --------

const parseDesiredTables = (): ReadonlyArray<DesiredTable> => {
	const out: DesiredTable[] = []
	for (const stmt of clickHouseMigrations[0]?.statements ?? []) {
		if (typeof stmt !== "string") continue
		const parsed = parseEmittedStatement(stmt)
		if (!parsed) continue
		out.push({
			name: parsed.name,
			kind: parsed.kind,
			columns:
				parsed.kind === "table"
					? parsed.columns.filter(
							(column) => !performanceOnlySearchColumns.has(`${parsed.name}.${column.name}`),
						)
					: [],
			createStatement: stmt,
		})
	}
	return out
}

const fetchActualSchema = (cfg: ChConfig): Effect.Effect<Map<string, ActualTable>, ClickHouseExecError> =>
	Effect.gen(function* () {
		const dbLit = cfg.database.replace(/'/g, "''")
		const tableRows = parseTableRows(
			yield* execClickHouse(
				cfg,
				`SELECT name, engine FROM system.tables WHERE database = '${dbLit}' FORMAT JSONEachRow`,
			),
		)
		const columnRows = parseColumnRows(
			yield* execClickHouse(
				cfg,
				`SELECT table, name, type FROM system.columns WHERE database = '${dbLit}' FORMAT JSONEachRow`,
			),
		)
		const colsByTable = new Map<string, Array<{ name: string; type: string }>>()
		for (const r of columnRows) {
			const list = colsByTable.get(r.table) ?? []
			list.push({ name: r.name, type: r.type })
			colsByTable.set(r.table, list)
		}
		const result = new Map<string, ActualTable>()
		for (const t of tableRows) {
			result.set(t.name, {
				name: t.name,
				kind: t.engine === "MaterializedView" ? "materialized_view" : "table",
				columns: colsByTable.get(t.name) ?? [],
			})
		}
		return result
	})

const reconcileSchemaSnapshot = (cfg: ChConfig): Effect.Effect<void, ClickHouseExecError> =>
	Effect.gen(function* () {
		const desired = parseDesiredTables()
		const desiredByName = new Map(desired.map((t) => [t.name, t]))
		const actual = yield* fetchActualSchema(cfg)
		for (const entry of computeSchemaDiff({ tables: desired }, actual)) {
			if (entry.status === "missing") {
				const table = desiredByName.get(entry.name)
				if (table) {
					yield* execClickHouse(
						cfg,
						qualifyStatementForDatabase(table.createStatement, cfg.database),
					)
				}
			} else if (entry.status === "drifted" && entry.kind === "table") {
				const table = desiredByName.get(entry.name)
				if (!table) continue
				for (const drift of entry.columnDrifts.filter((d) => d.kind === "missing")) {
					const colDef = extractColumnDefinition(table.createStatement, drift.column)
					if (colDef) {
						yield* execClickHouse(
							cfg,
							`ALTER TABLE ${quote(cfg.database)}.${quote(entry.name)} ADD COLUMN IF NOT EXISTS ${colDef}`,
						)
					}
				}
			}
		}
	})

// --- orchestration ----------------------------------------------------------

interface SkippedFeature {
	readonly id: string
	readonly reason: string
}

export const runClickHouseSchemaApply = (
	payload: SchemaApplyWorkflowPayload,
): Effect.Effect<
	SchemaApplyWorkflowResult,
	never,
	Database | Cloudflare.WorkflowStep | Cloudflare.WorkerEnvironment
> =>
	Effect.gen(function* () {
		const orgId = yield* Schema.decodeUnknownEffect(OrgId)(payload.orgId)
		const database = yield* Database
		const env = yield* Cloudflare.WorkerEnvironment

		// Inside the protected region below: a config-load failure (settings row
		// deleted, missing encryption key, decrypt failure, invalid URL) must still
		// transition the run row to failed, or the service reads the leftover
		// "queued" as already_running and the org can never apply its schema again.
		const markFailed = (cause: Cause.Cause<unknown>) =>
			Effect.gen(function* () {
				const finishedAt = yield* Clock.currentTimeMillis
				const message = causeMessage(cause)
				yield* updateRun(database, orgId, {
					status: "failed",
					errorMessage: message,
					finishedAt: msToDate(finishedAt),
				}).pipe(Effect.ignore)
				yield* database
					.execute((db) =>
						db
							.update(orgClickHouseSettings)
							.set({
								syncStatus: "error",
								lastSyncError: message,
								updatedAt: msToDate(finishedAt),
							})
							.where(eq(orgClickHouseSettings.orgId, orgId)),
					)
					.pipe(Effect.ignore)
				yield* bustRuntimeConfigCache(orgId)
			})

		return yield* applySchema(database, env, orgId).pipe(
			Effect.catchCause((cause) => markFailed(cause).pipe(Effect.andThen(Effect.failCause(cause)))),
		)
	}).pipe(Effect.orDie)

const applySchema = (database: DatabaseApi, env: Record<string, unknown>, orgId: OrgId) =>
	Effect.gen(function* () {
		const { MAPLE_INGEST_KEY_ENCRYPTION_KEY } = yield* Schema.decodeUnknownEffect(SchemaApplyEnv)(env)
		const encryptionKey = Buffer.from(MAPLE_INGEST_KEY_ENCRYPTION_KEY.trim(), "base64")
		const appliedVersions: number[] = []
		const skippedFeatures: SkippedFeature[] = []

		const cfg = yield* durableStep(
			"load-config",
			Effect.gen(function* () {
				const c = yield* loadConfig(database, orgId, encryptionKey)
				const startedAt = yield* Clock.currentTimeMillis
				yield* updateRun(database, orgId, {
					status: "running",
					phase: "connecting",
					errorMessage: null,
					startedAt: msToDate(startedAt),
				})
				return c
			}),
			STEP,
		)

		yield* durableStep("ensure-bookkeeping", ensureMigrationsTable(cfg), STEP)
		const applied = yield* durableStep("read-applied", readAppliedVersions(cfg), STEP)
		const appliedSet = new Set(applied)

		for (const migration of clickHouseMigrations) {
			if (migration.requiredForIngest === false) continue
			if (appliedSet.has(migration.version)) continue

			const steps = yield* durableStep(
				`plan-m${migration.version}`,
				planMigrationSteps(cfg, migration),
				STEP,
			)
			for (const [index, s] of steps.entries()) {
				// Progress rides inside the step: the body replays, so a write there
				// would repeat, and a clock read there would differ per replay.
				yield* durableStep(
					`m${migration.version}:${s.name}`,
					updateRun(database, orgId, {
						phase: `migration ${migration.version} · ${s.name}`,
						currentMigration: migration.version,
						stepsTotal: steps.length,
						stepsDone: index,
					}).pipe(Effect.andThen(execClickHouse(cfg, s.sql))),
					STEP,
				)
			}
			yield* durableStep(
				`record-m${migration.version}`,
				recordVersion(cfg, migration.version, migration.description),
				STEP,
			)
			appliedVersions.push(migration.version)
		}

		// Snapshot-diff additive pass: create snapshot objects missing on the
		// cluster + add missing columns (metadata-only, fits a step easily).
		yield* durableStep(
			"snapshot-diff",
			updateRun(database, orgId, { phase: "reconciling schema snapshot" }).pipe(
				Effect.andThen(reconcileSchemaSnapshot(cfg)),
			),
			STEP,
		)

		// Correctness is complete before optional performance work begins. This
		// keeps direct ingest ready even when a version-gated index cannot be
		// installed due to permissions, server support, or transient load.
		yield* durableStep(
			"stamp-correctness",
			Effect.gen(function* () {
				const stampedAt = yield* Clock.currentTimeMillis
				yield* database.execute((db) =>
					db
						.update(orgClickHouseSettings)
						.set({
							lastSyncAt: msToDate(stampedAt),
							lastSyncError: null,
							syncStatus: "connected",
							schemaVersion: clickHouseSchemaVersion,
							updatedAt: msToDate(stampedAt),
						})
						.where(eq(orgClickHouseSettings.orgId, orgId)),
				)
				yield* bustRuntimeConfigCache(orgId)
			}),
			STEP,
		)

		for (const migration of clickHouseMigrations) {
			if (migration.requiredForIngest !== false || appliedSet.has(migration.version)) continue
			const applyPerformanceMigration = Effect.gen(function* () {
				const steps = yield* durableStep(
					`plan-performance-m${migration.version}`,
					planMigrationSteps(cfg, migration),
					STEP,
				)
				for (const [index, migrationStep] of steps.entries()) {
					yield* durableStep(
						`performance-m${migration.version}:${migrationStep.name}`,
						updateRun(database, orgId, {
							phase: `performance migration ${migration.version} · ${index + 1}/${steps.length}`,
							currentMigration: migration.version,
							stepsTotal: steps.length,
							stepsDone: index,
						}).pipe(Effect.andThen(execClickHouse(cfg, migrationStep.sql))),
						STEP,
					)
				}
				yield* durableStep(
					`record-performance-m${migration.version}`,
					recordVersion(cfg, migration.version, migration.description),
					STEP,
				)
				appliedSet.add(migration.version)
				appliedVersions.push(migration.version)
			})
			// A performance migration that cannot be installed is skipped, never fatal.
			yield* applyPerformanceMigration.pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						skippedFeatures.push({
							id: `migration_${migration.version}`,
							reason: causeMessage(cause),
						})
					}),
				),
			)
		}

		const optionalFeatureState = yield* loadOptionalFeatureState({
			ensureBookkeeping: durableStep("ensure-feature-bookkeeping", ensureFeaturesTable(cfg), STEP),
			readServerVersion: durableStep(
				"read-clickhouse-version",
				execClickHouse(cfg, "SELECT version() FORMAT TabSeparated").pipe(
					Effect.map((value) => value.trim()),
				),
				STEP,
			),
			readAppliedFeatureRevisions: durableStep(
				"read-applied-features",
				readAppliedFeatureRevisions(cfg),
				STEP,
			).pipe(Effect.map((entries) => new Map(entries))),
		})
		if (!optionalFeatureState.available) {
			skippedFeatures.push({ id: "feature_reconciliation", reason: optionalFeatureState.reason })
		}
		if (optionalFeatureState.available) {
			const { serverVersion, appliedFeatureRevisions } = optionalFeatureState
			for (const feature of clickHouseSchemaFeatures) {
				if (!featureSupportedByVersion(feature, serverVersion)) {
					skippedFeatures.push({
						id: feature.id,
						reason: `requires ClickHouse ${feature.minClickHouseVersion}+`,
					})
					continue
				}
				if ((appliedFeatureRevisions.get(feature.id) ?? 0) >= feature.revision) continue

				const applyFeature = Effect.gen(function* () {
					const sortingKeyRequirement = feature.satisfiedBySortingKey
					const satisfied = sortingKeyRequirement
						? yield* durableStep(
								`feature-${feature.id}:inspect`,
								Effect.gen(function* () {
									const table = sortingKeyRequirement.table.replace(/'/g, "''")
									const result = yield* execClickHouse(
										cfg,
										`SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = '${table}' FORMAT JSONEachRow`,
									)
									const row = parseSortingKeyRows(result)[0]
									return (
										normalizeExpression(row?.sorting_key ?? "") ===
										normalizeExpression(sortingKeyRequirement.expected)
									)
								}),
								STEP,
							)
						: false

					if (!satisfied) {
						for (const [index, statement] of feature.statements.entries()) {
							yield* durableStep(
								`feature-${feature.id}:${index + 1}`,
								updateRun(database, orgId, {
									phase: `feature ${feature.id} · ${index + 1}/${feature.statements.length}`,
								}).pipe(Effect.andThen(execClickHouse(cfg, statement))),
								STEP,
							)
						}
					}
					yield* durableStep(
						`feature-${feature.id}:record`,
						recordFeature(cfg, feature.id, feature.revision, feature.description),
						STEP,
					)
				})
				yield* applyFeature.pipe(
					Effect.catchCause((cause) =>
						Effect.sync(() => {
							skippedFeatures.push({ id: feature.id, reason: causeMessage(cause) })
						}),
					),
				)
			}
		}

		yield* durableStep(
			"finalize",
			Effect.gen(function* () {
				const finishedAt = yield* Clock.currentTimeMillis
				yield* updateRun(database, orgId, {
					status: "succeeded",
					phase: "done",
					currentMigration: null,
					appliedVersions,
					skipped: skippedFeatures,
					finishedAt: msToDate(finishedAt),
				})
			}),
			STEP,
		)

		const result: SchemaApplyWorkflowResult = { status: "succeeded", appliedVersions }
		return result
	})
