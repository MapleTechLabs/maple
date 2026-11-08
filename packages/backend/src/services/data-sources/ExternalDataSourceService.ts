import { randomUUID } from "node:crypto"
import {
	DEFAULT_LIMITS,
	MAX_TIME_BUCKETS,
	defaultGranularitySeconds,
	didYouMean,
	searchCatalogs,
	suggestNames,
	type DataSourceDriver,
	type DriverConnection,
	type QueryContext,
	type QueryWorkload,
	type SearchableSource,
} from "@maple/data-sources"
import {
	type CatalogEntry,
	type CatalogEntryView,
	type CreateExternalDataSourceInput,
	type DataSourceDriverError,
	DataSourceLimitError,
	DataSourceNotFoundError,
	DataSourcePersistenceError,
	type DataSourceQueryResult,
	DataSourceRateLimitedError,
	type DataSourceSearchHit,
	type DataSourceTestResult,
	DataSourceTimeoutError,
	DataSourceValidationError,
	ExternalDataSourceId,
	type ExternalDataSourceDocument,
	type ExternalQuery,
	QUERY_LANGUAGE_BY_KIND,
	type SourceCatalog,
	type UpdateCatalogEntryInput,
	type UpdateExternalDataSourceInput,
} from "@maple/domain/data-sources"
import type { OrgId, UserId } from "@maple/domain/primitives"
import {
	ExternalDataSourceCatalogEntries,
	ExternalDataSources,
	type ExternalDataSourceCatalogEntryRow,
	type ExternalDataSourceRow,
} from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	Array as Arr,
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	MutableHashMap,
	Option,
	Order,
	Record as Rec,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { DataSourceCallBudget, DataSourceDrivers } from "./DataSourceDrivers"
import { DataSourceCallBudgetLive } from "./DataSourceCallBudgetLive"
import { DATA_SOURCE_DRIVERS } from "./drivers"

// Connected systems Maple queries in place. Owns storage, secrets, catalogs, search and the
// query path every surface (dashboards, alerts, MCP tools, the API) goes through.
// Plan: docs/external-data-sources-plan.md.

/** Most catalog entries kept per source; past it the admin picks which to expose. */
const MAX_CATALOG_ENTRIES = 2_000
const TEST_TIMEOUT = Duration.seconds(15)
const CATALOG_TIMEOUT = Duration.seconds(60)

export type ExternalDataSourceServiceError =
	| DataSourceDriverError
	| DataSourceNotFoundError
	| DataSourcePersistenceError

/** How a caller reaches sources. Agents never see sources with agent access off, nor PII unless allowed. */
export interface Audience {
	readonly agent: boolean
}

export interface QueryInput {
	readonly startMs: number
	readonly endMs: number
	readonly granularitySeconds?: number
	readonly workload: QueryWorkload
	/** Plan and cost the query without running it. */
	readonly explain?: boolean
}

export interface CatalogView {
	readonly source: ExternalDataSourceDocument
	readonly entries: ReadonlyArray<CatalogEntryView>
	readonly examples: SourceCatalog["examples"]
}

export interface ExternalDataSourceServiceApi {
	readonly list: (
		orgId: OrgId,
		audience: Audience,
	) => Effect.Effect<ReadonlyArray<ExternalDataSourceDocument>, DataSourcePersistenceError>
	/** By id or name. */
	readonly get: (
		orgId: OrgId,
		ref: string,
		audience: Audience,
	) => Effect.Effect<ExternalDataSourceDocument, DataSourceNotFoundError | DataSourcePersistenceError>
	/** Tests the connection first; nothing is saved when it fails. Then captures the catalog. */
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		input: CreateExternalDataSourceInput,
	) => Effect.Effect<ExternalDataSourceDocument, ExternalDataSourceServiceError>
	readonly update: (
		orgId: OrgId,
		userId: UserId,
		id: ExternalDataSourceId,
		input: UpdateExternalDataSourceInput,
	) => Effect.Effect<ExternalDataSourceDocument, ExternalDataSourceServiceError>
	readonly remove: (
		orgId: OrgId,
		id: ExternalDataSourceId,
	) => Effect.Effect<void, DataSourceNotFoundError | DataSourcePersistenceError>
	/** Records the outcome on the source; a failed test is a result, not an error. */
	readonly test: (
		orgId: OrgId,
		id: ExternalDataSourceId,
	) => Effect.Effect<DataSourceTestResult, DataSourceNotFoundError | DataSourcePersistenceError>
	readonly refreshCatalog: (
		orgId: OrgId,
		id: ExternalDataSourceId,
	) => Effect.Effect<ExternalDataSourceDocument, ExternalDataSourceServiceError>
	/** The stored catalog with curation applied. Agents see exposed entries only. */
	readonly catalog: (
		orgId: OrgId,
		ref: string,
		audience: Audience,
	) => Effect.Effect<CatalogView, DataSourceNotFoundError | DataSourcePersistenceError>
	readonly updateCatalogEntry: (
		orgId: OrgId,
		id: ExternalDataSourceId,
		entry: string,
		input: UpdateCatalogEntryInput,
	) => Effect.Effect<
		CatalogEntryView,
		DataSourceNotFoundError | DataSourceValidationError | DataSourcePersistenceError
	>
	readonly search: (
		orgId: OrgId,
		query: string,
		audience: Audience,
		limit?: number,
	) => Effect.Effect<ReadonlyArray<DataSourceSearchHit>, DataSourcePersistenceError>
	readonly query: (
		orgId: OrgId,
		ref: string,
		query: ExternalQuery,
		input: QueryInput,
		audience: Audience,
	) => Effect.Effect<DataSourceQueryResult, ExternalDataSourceServiceError>
}

const toPersistenceError = makePersistenceErrorMapper(
	DataSourcePersistenceError,
	"External data source persistence failure",
)

/** Binds a secret to its org and source: a row copied elsewhere no longer decrypts. */
const secretAad = (orgId: OrgId, id: ExternalDataSourceId) =>
	Buffer.from(`external_data_sources:v1:${orgId}:${id}`, "utf8")

const decodeId = Schema.decodeUnknownOption(ExternalDataSourceId)

/** An admin hid it, or wrote any note or override on it: its row outlives a refresh that misses it. */
const isCurated = (
	entry: Pick<ExternalDataSourceCatalogEntryRow, "exposed" | "note" | "timeFieldOverride" | "fieldNotes">,
): boolean =>
	!entry.exposed ||
	entry.note !== null ||
	entry.timeFieldOverride !== null ||
	Rec.keys(entry.fieldNotes).length > 0

/** A worked example that names a hidden entry would tell an agent it exists. */
const examplesFor = (
	examples: SourceCatalog["examples"],
	hidden: ReadonlyArray<string>,
): SourceCatalog["examples"] =>
	Arr.filter(
		examples,
		({ query }) =>
			!Arr.some(hidden, (name) => {
				if (query._tag === "resource") return query.resource === name
				const table = Arr.lastNonEmpty(Str.split(".")(name))
				return (
					Str.includes(name)(query.sql) ||
					new RegExp(`(?<![\\w.])\`?${escapeRegExp(table)}\`?(?![\\w])`).test(query.sql)
				)
			}),
	)

const escapeRegExp = (text: string): string => Str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")(text)

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** The last 4 characters, only for secrets long enough that 4 reveal little (API keys, not passwords). */
const MIN_HINTED_SECRET_LENGTH = 16
const secretHint = (secret: string): string | null =>
	secret.length >= MIN_HINTED_SECRET_LENGTH ? Str.slice(-4)(secret) : null

const toDocument = (row: ExternalDataSourceRow, entryCount: number): ExternalDataSourceDocument => ({
	id: row.id,
	name: row.name,
	kind: row.kind,
	queryLanguage: QUERY_LANGUAGE_BY_KIND[row.kind],
	description: row.description,
	environment: row.environment,
	tags: row.tags,
	agentAccess: row.agentAccess,
	agentPii: row.agentPii,
	config: row.config,
	hasSecret: row.secretCiphertext !== null,
	secretHint: row.secretHint,
	status: row.status,
	lastCheckedAt: row.lastCheckedAt,
	lastError: row.lastError,
	catalogRefreshedAt: row.catalogRefreshedAt,
	catalogEntryCount: entryCount,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

/** Stored entry → what describe shows: admin note over source note, admin time field over detected. */
const toEntryView = (row: ExternalDataSourceCatalogEntryRow): CatalogEntryView => {
	const note = row.note ?? row.sourceNote
	const timeField = row.timeFieldOverride ?? row.detectedTimeField
	let view: CatalogEntryView = {
		name: row.name,
		kind: row.kind,
		fields: Arr.map(row.fields, (field) => {
			const fieldNote = row.fieldNotes[field.name]
			return fieldNote === undefined ? field : { ...field, note: fieldNote }
		}),
		exposed: row.exposed,
	}
	if (note !== null) view = { ...view, note }
	if (row.rowEstimate !== null) view = { ...view, rowEstimate: row.rowEstimate }
	if (timeField !== null) view = { ...view, timeField }
	return view
}

const errorText = (error: { readonly message: string }): string => error.message

export class ExternalDataSourceService extends Context.Service<
	ExternalDataSourceService,
	ExternalDataSourceServiceApi
>()("@maple/backend/services/data-sources/ExternalDataSourceService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const drivers = yield* DataSourceDrivers
		const budget = yield* DataSourceCallBudget
		const httpClient = yield* HttpClient.HttpClient
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			(message) => new DataSourcePersistenceError({ message }),
		)
		const dbExecute = makeDbExecute(database, "ExternalDataSourceService", toPersistenceError)
		const persistenceError = (message: string) => new DataSourcePersistenceError({ message })

		const driverFor = (
			kind: ExternalDataSourceRow["kind"],
		): Effect.Effect<DataSourceDriver, DataSourceValidationError> => {
			const driver = drivers.get(kind)
			return driver === undefined
				? Effect.fail(
						new DataSourceValidationError({
							message: `This deployment cannot query ${kind} sources`,
						}),
					)
				: Effect.succeed(driver)
		}

		// A source that answered 429 is left alone until its Retry-After passes. Per isolate: it stops a
		// burst of widgets or retries from one Worker, the rate-limit bindings cover the fleet.
		const cooldowns = MutableHashMap.empty<ExternalDataSourceId, number>()

		/** Runs a driver call against one source: Maple's HTTP client, and its 429s remembered. */
		const callSource = <A, E>(
			row: Pick<ExternalDataSourceRow, "id">,
			effect: Effect.Effect<A, E, HttpClient.HttpClient>,
		) =>
			Effect.provideService(effect, HttpClient.HttpClient, httpClient).pipe(
				Effect.tapError((error) =>
					Schema.is(DataSourceRateLimitedError)(error) && error.retryAfterSeconds !== undefined
						? Effect.map(Clock.currentTimeMillis, (now) => {
								MutableHashMap.set(
									cooldowns,
									row.id,
									now + (error.retryAfterSeconds ?? 0) * 1000,
								)
							})
						: Effect.void,
				),
			)

		const contextFor = (row: Pick<ExternalDataSourceRow, "id" | "config">): QueryContext => ({
			spend: (calls) =>
				Effect.flatMap(Clock.currentTimeMillis, (now) => {
					const until = Option.getOrElse(MutableHashMap.get(cooldowns, row.id), () => 0)
					return until > now
						? Effect.fail(
								new DataSourceRateLimitedError({
									message:
										"The source asked Maple to slow down; waiting for its Retry-After before calling again.",
									retryAfterSeconds: Math.ceil((until - now) / 1000),
								}),
							)
						: budget.spend({ id: row.id, config: row.config }, calls)
				}),
		})

		// ── Rows ───────────────────────────────────────────────────────────

		const loadRows = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(ExternalDataSources)
						.select()
						.where(($) => [$.orgId.eq(orgId)]),
				),
			)

		const loadEntries = (orgId: OrgId, sourceId?: ExternalDataSourceId) =>
			dbExecute((db) =>
				db.run(
					PG.from(ExternalDataSourceCatalogEntries)
						.select()
						.where(($) =>
							sourceId === undefined
								? [$.orgId.eq(orgId)]
								: [$.orgId.eq(orgId), $.sourceId.eq(sourceId)],
						),
				),
			)

		const loadEntryKeys = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(ExternalDataSourceCatalogEntries)
						.select("sourceId", "exposed", "seenAt")
						.where(($) => [$.orgId.eq(orgId)]),
				),
			)

		const visible = (row: ExternalDataSourceRow, audience: Audience) => !audience.agent || row.agentAccess

		/** Seen by the latest refresh. Curated entries that dropped out are kept for their curation, not shown. */
		const present = (row: ExternalDataSourceRow) => (entry: { readonly seenAt: number }) =>
			row.catalogRefreshedAt === null || entry.seenAt >= row.catalogRefreshedAt

		const hiddenOf = (
			row: ExternalDataSourceRow,
			entries: ReadonlyArray<ExternalDataSourceCatalogEntryRow>,
		): ReadonlyArray<string> =>
			Arr.map(
				Arr.filter(entries, (entry) => entry.sourceId === row.id && !entry.exposed),
				(entry) => entry.name,
			)

		/** What one audience may see of a source's catalog: agents never get hidden entries. */
		const entriesFor = <
			E extends Pick<ExternalDataSourceCatalogEntryRow, "sourceId" | "exposed" | "seenAt">,
		>(
			row: ExternalDataSourceRow,
			entries: ReadonlyArray<E>,
			audience: Audience,
		) =>
			Arr.filter(
				entries,
				(entry) =>
					entry.sourceId === row.id && present(row)(entry) && (!audience.agent || entry.exposed),
			)

		/** By id or by name; misses suggest the closest visible names. */
		const resolve = Effect.fn("ExternalDataSourceService.resolve")(function* (
			orgId: OrgId,
			ref: string,
			audience: Audience,
		) {
			const allRows = yield* loadRows(orgId)
			const rows = Arr.filter(allRows, (row) => visible(row, audience))
			const trimmed = Str.trim(ref)
			const asId = decodeId(trimmed)
			const found = Arr.findFirst(rows, (row) =>
				Option.isSome(asId) ? row.id === asId.value : row.name === Str.toLowerCase(trimmed),
			)
			if (Option.isSome(found)) return found.value
			const names = Arr.map(rows, (row) => row.name)
			return yield* new DataSourceNotFoundError({
				message:
					rows.length === 0
						? `No data source "${trimmed}": this organization has no connected data sources${audience.agent ? " available to agents" : ""}.`
						: `No data source "${trimmed}".${didYouMean(trimmed, names)} Available: ${Arr.join(names, ", ")}.`,
				rawRef: trimmed,
				suggestions: suggestNames(trimmed, names),
			})
		})

		const resolveById = (orgId: OrgId, id: ExternalDataSourceId) => resolve(orgId, id, { agent: false })

		const documentFor = (row: ExternalDataSourceRow) =>
			Effect.map(loadEntries(row.orgId, row.id), (entries) =>
				toDocument(row, entriesFor(row, entries, { agent: false }).length),
			)

		const connectionFor = Effect.fn("ExternalDataSourceService.connectionFor")(function* (
			row: ExternalDataSourceRow,
		) {
			if (row.secretCiphertext === null || row.secretIv === null || row.secretTag === null) {
				return { sourceId: row.id, config: row.config, secret: null } satisfies DriverConnection
			}
			const secret = yield* decryptAes256Gcm(
				{ ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag },
				encryptionKey,
				persistenceError,
				secretAad(row.orgId, row.id),
			)
			return {
				sourceId: row.id,
				config: row.config,
				secret: Redacted.make(secret),
			} satisfies DriverConnection
		})

		const recordStatus = (
			orgId: OrgId,
			id: ExternalDataSourceId,
			patch: Partial<
				Pick<
					ExternalDataSourceRow,
					| "status"
					| "lastCheckedAt"
					| "lastError"
					| "catalogRefreshedAt"
					| "catalogError"
					| "examples"
				>
			>,
		) =>
			dbExecute((db) =>
				db.run(
					PG.update(ExternalDataSources)
						.set(patch)
						.where(($) => [$.orgId.eq(orgId), $.id.eq(id)]),
				),
			)

		// ── Catalog ────────────────────────────────────────────────────────

		const storeCatalog = Effect.fn("ExternalDataSourceService.storeCatalog")(function* (
			orgId: OrgId,
			id: ExternalDataSourceId,
			catalog: SourceCatalog,
			previousRefreshAt: number | null,
		) {
			// Strictly after the last refresh, so "seen by the latest refresh" never ties with an older one.
			const clock = yield* Clock.currentTimeMillis
			const now = previousRefreshAt === null ? clock : Math.max(clock, previousRefreshAt + 1)
			const entries: ReadonlyArray<CatalogEntry> = Arr.take(catalog.entries, MAX_CATALOG_ENTRIES)
			yield* Effect.annotateCurrentSpan({ "maple.data_source.catalog_entries": entries.length })
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* Effect.forEach(
							Arr.chunksOf(entries, 200),
							(chunk) =>
								db.run(
									PG.insertInto(ExternalDataSourceCatalogEntries)
										.values(
											Arr.map(chunk, (entry) => ({
												sourceId: id,
												orgId,
												name: entry.name,
												kind: entry.kind,
												rowEstimate: entry.rowEstimate ?? null,
												sourceNote: entry.note ?? null,
												detectedTimeField: entry.timeField ?? null,
												fields: entry.fields,
												seenAt: now,
											})),
										)
										.onConflictDoUpdate({
											target: ["sourceId", "name"],
											set: (_$, excluded) => ({
												kind: excluded.kind,
												rowEstimate: excluded.rowEstimate,
												sourceNote: excluded.sourceNote,
												detectedTimeField: excluded.detectedTimeField,
												fields: excluded.fields,
												seenAt: excluded.seenAt,
											}),
										}),
								),
							{ discard: true },
						)
						// Gone from the source, matched by name (two refreshes can share a millisecond). Entries an
						// admin hid or annotated in any way stay, unseen, so one that drops out and returns keeps
						// its curation.
						const seen = new Set(Arr.map(entries, (e) => e.name))
						const stored = yield* db.run(
							PG.from(ExternalDataSourceCatalogEntries)
								.select("name", "exposed", "note", "timeFieldOverride", "fieldNotes")
								.where(($) => [$.orgId.eq(orgId), $.sourceId.eq(id)]),
						)
						const gone = Arr.filter(stored, (entry) => !seen.has(entry.name) && !isCurated(entry))
						yield* Effect.forEach(
							gone,
							(entry) =>
								db.run(
									PG.deleteFrom(ExternalDataSourceCatalogEntries).where(($) => [
										$.orgId.eq(orgId),
										$.sourceId.eq(id),
										$.name.eq(entry.name),
									]),
								),
							{ discard: true },
						)
						yield* db.run(
							PG.update(ExternalDataSources)
								.set({
									catalogRefreshedAt: now,
									catalogError: null,
									examples: catalog.examples,
								})
								.where(($) => [$.orgId.eq(orgId), $.id.eq(id)]),
						)
					}),
				),
			)
		})

		const captureCatalog = Effect.fn("ExternalDataSourceService.captureCatalog")(function* (
			row: ExternalDataSourceRow,
		) {
			yield* Effect.annotateCurrentSpan({
				"maple.data_source.id": row.id,
				"maple.data_source.kind": row.kind,
			})
			const driver = yield* driverFor(row.kind)
			const connection = yield* connectionFor(row)
			const catalog = yield* callSource(row, driver.catalog(connection, contextFor(row))).pipe(
				Effect.timeoutOrElse({
					duration: CATALOG_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new DataSourceTimeoutError({
								message: "Reading the source's catalog took too long",
								timeoutMs: Duration.toMillis(CATALOG_TIMEOUT),
							}),
						),
				}),
			)
			yield* storeCatalog(row.orgId, row.id, catalog, row.catalogRefreshedAt)
		})

		/** Catalog failures are recorded on the source, not raised: the source itself is fine. */
		const captureCatalogRecorded = (row: ExternalDataSourceRow) =>
			captureCatalog(row).pipe(
				Effect.catchTags({
					"@maple/data-sources/Validation": (error) =>
						recordStatus(row.orgId, row.id, { catalogError: errorText(error) }),
					"@maple/data-sources/Connection": (error) =>
						recordStatus(row.orgId, row.id, { catalogError: errorText(error) }),
					"@maple/data-sources/Query": (error) =>
						recordStatus(row.orgId, row.id, { catalogError: errorText(error) }),
					"@maple/data-sources/Timeout": (error) =>
						recordStatus(row.orgId, row.id, { catalogError: errorText(error) }),
					"@maple/data-sources/Limit": (error) =>
						recordStatus(row.orgId, row.id, { catalogError: errorText(error) }),
					"@maple/data-sources/RateLimited": (error) =>
						recordStatus(row.orgId, row.id, { catalogError: errorText(error) }),
					"@maple/data-sources/Persistence": (error) =>
						Effect.logWarning("Could not store the data source catalog").pipe(
							Effect.annotateLogs({ sourceId: row.id, error: error.message }),
						),
				}),
			)

		const sourceCatalogFor = (
			rows: ReadonlyArray<ExternalDataSourceCatalogEntryRow>,
			examples: SourceCatalog["examples"],
		): SourceCatalog => ({
			entries: Arr.map(rows, (row) => {
				const { exposed: _exposed, ...entry } = toEntryView(row)
				return entry
			}),
			examples,
			truncated: false,
		})

		// ── Test ───────────────────────────────────────────────────────────

		const runTest = (
			driver: DataSourceDriver,
			connection: DriverConnection,
			row: Pick<ExternalDataSourceRow, "id" | "config">,
		) =>
			Effect.gen(function* () {
				const started = yield* Clock.currentTimeMillis
				const outcome = yield* callSource(row, driver.test(connection, contextFor(row))).pipe(
					Effect.timeoutOrElse({
						duration: TEST_TIMEOUT,
						orElse: () =>
							Effect.fail(
								new DataSourceTimeoutError({
									message: "The source did not answer within 15 seconds",
									timeoutMs: Duration.toMillis(TEST_TIMEOUT),
								}),
							),
					}),
					Effect.result,
				)
				const latencyMs = (yield* Clock.currentTimeMillis) - started
				return outcome._tag === "Success"
					? ({
							ok: true,
							latencyMs,
							warnings: outcome.success.warnings,
						} satisfies DataSourceTestResult)
					: ({
							ok: false,
							latencyMs,
							warnings: [],
							error: errorText(outcome.failure),
						} satisfies DataSourceTestResult)
			}).pipe(
				Effect.withSpan("ExternalDataSourceService.runTest", {
					attributes: { "maple.data_source.kind": driver.kind },
				}),
			)

		// ── Public API ─────────────────────────────────────────────────────

		const list = Effect.fn("ExternalDataSourceService.list")(function* (
			orgId: OrgId,
			audience: Audience,
		) {
			// Only the two columns the counts need: the chat prompt lists sources on every turn.
			const [rows, entries] = yield* Effect.all([loadRows(orgId), loadEntryKeys(orgId)], {
				concurrency: 2,
			})
			const visibleRows = Arr.filter(rows, (row) => visible(row, audience))
			return Arr.map(
				Arr.sort(
					visibleRows,
					Order.mapInput(Order.String, (row: ExternalDataSourceRow) => row.name),
				),
				(row) => toDocument(row, entriesFor(row, entries, audience).length),
			)
		})

		const get = Effect.fn("ExternalDataSourceService.get")(function* (
			orgId: OrgId,
			ref: string,
			audience: Audience,
		) {
			const row = yield* resolve(orgId, ref, audience)
			return yield* documentFor(row)
		})

		const create = Effect.fn("ExternalDataSourceService.create")(function* (
			orgId: OrgId,
			userId: UserId,
			input: CreateExternalDataSourceInput,
		) {
			const kind = input.connection._tag
			yield* Effect.annotateCurrentSpan({ "maple.data_source.kind": kind })
			const existing = yield* loadRows(orgId)
			if (Arr.some(existing, (row) => row.name === input.name)) {
				return yield* new DataSourceValidationError({
					message: `A data source named "${input.name}" already exists`,
					field: "name",
				})
			}
			const driver = yield* driverFor(kind)
			const validated = yield* driver.validateConnection(input.connection, null)
			const id = yield* Schema.decodeEffect(ExternalDataSourceId)(randomUUID()).pipe(
				Effect.mapError(() => persistenceError("Could not mint a data source id")),
			)
			yield* Effect.annotateCurrentSpan({ "maple.data_source.id": id })
			const connection: DriverConnection = {
				sourceId: id,
				config: validated.config,
				secret: validated.secret === null ? null : Redacted.make(validated.secret),
			}
			const test = yield* runTest(driver, connection, { id, config: validated.config })
			if (!test.ok) {
				return yield* new DataSourceValidationError({
					message: `Could not connect: ${test.error ?? "unknown error"}`,
					field: "connection",
				})
			}
			const encrypted =
				validated.secret === null
					? null
					: yield* encryptAes256Gcm(
							validated.secret,
							encryptionKey,
							persistenceError,
							secretAad(orgId, id),
						)
			const now = yield* Clock.currentTimeMillis
			yield* dbExecute((db) =>
				db.run(
					PG.insertInto(ExternalDataSources).values({
						id,
						orgId,
						name: input.name,
						kind,
						description: input.description,
						environment: input.environment,
						tags: input.tags ?? [],
						agentAccess: input.agentAccess ?? true,
						agentPii: input.agentPii ?? false,
						config: validated.config,
						secretCiphertext: encrypted?.ciphertext ?? null,
						secretIv: encrypted?.iv ?? null,
						secretTag: encrypted?.tag ?? null,
						secretHint: validated.secret === null ? null : secretHint(validated.secret),
						status: "ok",
						lastCheckedAt: now,
						lastError: null,
						catalogRefreshedAt: null,
						catalogError: null,
						examples: [],
						createdAt: now,
						updatedAt: now,
						createdBy: userId,
						updatedBy: userId,
					}),
				),
			)
			const row = yield* resolveById(orgId, id)
			yield* captureCatalogRecorded(row)
			return yield* Effect.flatMap(resolveById(orgId, id), documentFor)
		})

		const update = Effect.fn("ExternalDataSourceService.update")(function* (
			orgId: OrgId,
			userId: UserId,
			id: ExternalDataSourceId,
			input: UpdateExternalDataSourceInput,
		) {
			yield* Effect.annotateCurrentSpan({ "maple.data_source.id": id })
			const row = yield* resolveById(orgId, id)
			if (input.name !== undefined && input.name !== row.name) {
				const rows = yield* loadRows(orgId)
				if (Arr.some(rows, (other) => other.name === input.name)) {
					return yield* new DataSourceValidationError({
						message: `A data source named "${input.name}" already exists`,
						field: "name",
					})
				}
			}
			const now = yield* Clock.currentTimeMillis
			let connectionPatch: Partial<ExternalDataSourceRow> = {}
			if (input.connection !== undefined) {
				if (input.connection._tag !== row.kind) {
					return yield* new DataSourceValidationError({
						message: `This is a ${row.kind} source; its connection cannot change kind`,
						field: "connection",
					})
				}
				const driver = yield* driverFor(row.kind)
				const validated = yield* driver.validateConnection(input.connection, row.config)
				const stored = yield* connectionFor(row)
				const secret = validated.secret === null ? stored.secret : Redacted.make(validated.secret)
				const test = yield* runTest(
					driver,
					{ sourceId: id, config: validated.config, secret },
					{ id, config: validated.config },
				)
				if (!test.ok) {
					return yield* new DataSourceValidationError({
						message: `Could not connect: ${test.error ?? "unknown error"}`,
						field: "connection",
					})
				}
				const encrypted =
					validated.secret === null
						? null
						: yield* encryptAes256Gcm(
								validated.secret,
								encryptionKey,
								persistenceError,
								secretAad(orgId, id),
							)
				const checked = {
					config: validated.config,
					status: "ok" as const,
					lastCheckedAt: now,
					lastError: null,
				}
				connectionPatch =
					encrypted === null || validated.secret === null
						? checked
						: {
								...checked,
								secretCiphertext: encrypted.ciphertext,
								secretIv: encrypted.iv,
								secretTag: encrypted.tag,
								secretHint: secretHint(validated.secret),
							}
			}
			// Absent keys stay absent (optionalKey), so the input's own fields are the column patch.
			const { connection: _connection, ...fields } = input
			yield* dbExecute((db) =>
				db.run(
					PG.update(ExternalDataSources)
						.set({ ...fields, ...connectionPatch, updatedAt: now, updatedBy: userId })
						.where(($) => [$.orgId.eq(orgId), $.id.eq(id)]),
				),
			)
			const next = yield* resolveById(orgId, id)
			if (input.connection !== undefined) yield* captureCatalogRecorded(next)
			return yield* Effect.flatMap(resolveById(orgId, id), documentFor)
		})

		const remove = Effect.fn("ExternalDataSourceService.remove")(function* (
			orgId: OrgId,
			id: ExternalDataSourceId,
		) {
			yield* resolveById(orgId, id)
			yield* dbExecute((db) =>
				db.run(PG.deleteFrom(ExternalDataSources).where(($) => [$.orgId.eq(orgId), $.id.eq(id)])),
			)
		})

		const test = Effect.fn("ExternalDataSourceService.test")(function* (
			orgId: OrgId,
			id: ExternalDataSourceId,
		) {
			const row = yield* resolveById(orgId, id)
			yield* Effect.annotateCurrentSpan({
				"maple.data_source.id": id,
				"maple.data_source.kind": row.kind,
			})
			const driver = yield* driverFor(row.kind).pipe(Effect.result)
			if (driver._tag === "Failure") {
				return {
					ok: false,
					latencyMs: 0,
					warnings: [],
					error: driver.failure.message,
				} satisfies DataSourceTestResult
			}
			const connection = yield* connectionFor(row)
			const result = yield* runTest(driver.success, connection, row)
			yield* recordStatus(orgId, id, {
				status: result.ok ? "ok" : "error",
				lastCheckedAt: yield* Clock.currentTimeMillis,
				lastError: result.error ?? null,
			})
			return result
		})

		const refreshCatalog = Effect.fn("ExternalDataSourceService.refreshCatalog")(function* (
			orgId: OrgId,
			id: ExternalDataSourceId,
		) {
			const row = yield* resolveById(orgId, id)
			yield* captureCatalog(row).pipe(
				Effect.tapError((error) => recordStatus(orgId, id, { catalogError: errorText(error) })),
			)
			return yield* Effect.flatMap(resolveById(orgId, id), documentFor)
		})

		const catalog = Effect.fn("ExternalDataSourceService.catalog")(function* (
			orgId: OrgId,
			ref: string,
			audience: Audience,
		) {
			const row = yield* resolve(orgId, ref, audience)
			const stored = yield* loadEntries(orgId, row.id)
			const shown = Arr.map(entriesFor(row, stored, audience), toEntryView)
			const redacted =
				audience.agent && !row.agentPii
					? Arr.map(shown, (entry) => ({
							...entry,
							fields: Arr.map(entry.fields, (field) =>
								field.pii === true ? { ...field, sampleValues: [] } : field,
							),
						}))
					: shown
			return {
				source: toDocument(row, shown.length),
				entries: Arr.sort(
					redacted,
					Order.mapInput(Order.String, (entry: CatalogEntryView) => entry.name),
				),
				examples: audience.agent ? examplesFor(row.examples, hiddenOf(row, stored)) : row.examples,
			} satisfies CatalogView
		})

		const updateCatalogEntry = Effect.fn("ExternalDataSourceService.updateCatalogEntry")(function* (
			orgId: OrgId,
			id: ExternalDataSourceId,
			entryName: string,
			input: UpdateCatalogEntryInput,
		) {
			yield* resolveById(orgId, id)
			const entries = yield* loadEntries(orgId, id)
			const entry = Arr.findFirst(entries, (row) => row.name === entryName)
			if (Option.isNone(entry)) {
				return yield* new DataSourceValidationError({
					message: `No catalog entry "${entryName}".${didYouMean(
						entryName,
						Arr.map(entries, (row) => row.name),
					)}`,
					field: "entry",
				})
			}
			if (
				input.timeField !== undefined &&
				input.timeField !== null &&
				!Arr.some(entry.value.fields, (field) => field.name === input.timeField)
			) {
				return yield* new DataSourceValidationError({
					message: `"${entryName}" has no field "${input.timeField}"`,
					field: "timeField",
				})
			}
			const { timeField, ...direct } = input
			const curation = timeField === undefined ? direct : { ...direct, timeFieldOverride: timeField }
			yield* dbExecute((db) =>
				db.run(
					PG.update(ExternalDataSourceCatalogEntries)
						.set(curation)
						.where(($) => [$.orgId.eq(orgId), $.sourceId.eq(id), $.name.eq(entryName)]),
				),
			)
			const after = yield* loadEntries(orgId, id)
			const updated = Arr.findFirst(after, (row) => row.name === entryName)
			return yield* Option.match(updated, {
				onNone: () =>
					Effect.fail(persistenceError("The catalog entry disappeared while it was updated")),
				onSome: (row) => Effect.succeed(toEntryView(row)),
			})
		})

		const search = Effect.fn("ExternalDataSourceService.search")(function* (
			orgId: OrgId,
			query: string,
			audience: Audience,
			limit?: number,
		) {
			const [rows, entries] = yield* Effect.all([loadRows(orgId), loadEntries(orgId)], {
				concurrency: 2,
			})
			const sources: ReadonlyArray<SearchableSource> = Arr.map(
				Arr.filter(rows, (row) => visible(row, audience)),
				(row) => ({
					id: row.id,
					name: row.name,
					description: row.description,
					environment: row.environment,
					tags: row.tags,
					queryLanguage: QUERY_LANGUAGE_BY_KIND[row.kind],
					entries: Arr.map(entriesFor(row, entries, audience), (entry) => {
						const view = toEntryView(entry)
						return audience.agent && !row.agentPii
							? {
									...view,
									fields: Arr.map(view.fields, (field) =>
										field.pii === true ? { ...field, sampleValues: [] } : field,
									),
								}
							: view
					}),
				}),
			)
			const hits = searchCatalogs(sources, query, limit)
			yield* Effect.annotateCurrentSpan({ "maple.data_source.search_hits": hits.length })
			return hits
		})

		const query = Effect.fn("ExternalDataSourceService.query")(function* (
			orgId: OrgId,
			ref: string,
			externalQuery: ExternalQuery,
			input: QueryInput,
			audience: Audience,
		) {
			const row = yield* resolve(orgId, ref, audience)
			yield* Effect.annotateCurrentSpan({
				"maple.data_source.id": row.id,
				"maple.data_source.kind": row.kind,
				"maple.data_source.workload": input.workload,
				"maple.data_source.explain": input.explain === true,
			})
			if (!(input.endMs > input.startMs)) {
				return yield* new DataSourceValidationError({
					message: "The time window must end after it starts",
				})
			}
			const driver = yield* driverFor(row.kind)
			const language = QUERY_LANGUAGE_BY_KIND[row.kind]
			const wantsSql = Str.startsWith("sql:")(language)
			if (wantsSql !== (externalQuery._tag === "sql")) {
				return yield* new DataSourceValidationError({
					message: wantsSql
						? `"${row.name}" is a ${row.kind} database: send SQL (\`sql\`), not a resource query.`
						: `"${row.name}" is a ${row.kind} API: it takes a resource query, not SQL. Use describe_data_source to see its resources and an example.`,
					field: "query",
				})
			}
			const granularitySeconds =
				input.granularitySeconds ?? defaultGranularitySeconds(input.startMs, input.endMs)
			if (
				!(granularitySeconds >= 1) ||
				(input.endMs - input.startMs) / 1000 / granularitySeconds > MAX_TIME_BUCKETS
			) {
				return yield* new DataSourceValidationError({
					message: `A ${Math.round(granularitySeconds)}s granularity over this window makes more than ${MAX_TIME_BUCKETS} time buckets; use a coarser granularity or a shorter window.`,
					field: "granularitySeconds",
				})
			}
			// Agents query only what they may see, so hints and resource checks never name hidden entries.
			const [connection, stored] = yield* Effect.all([connectionFor(row), loadEntries(orgId, row.id)])
			const entries = entriesFor(row, stored, audience)
			const limits = DEFAULT_LIMITS[input.workload]
			const prepared = yield* driver.prepare(
				connection,
				externalQuery,
				{
					window: {
						startMs: input.startMs,
						endMs: input.endMs,
						granularitySeconds,
					},
					limits,
					workload: input.workload,
					redactPii: audience.agent && !row.agentPii,
				},
				sourceCatalogFor(
					entries,
					audience.agent ? examplesFor(row.examples, hiddenOf(row, stored)) : row.examples,
				),
			)
			if (input.explain === true) {
				return {
					columns: [],
					rows: [],
					truncated: false,
					language,
					plan: prepared.summary,
					executed: false,
				} satisfies DataSourceQueryResult
			}
			const table = yield* callSource(row, prepared.run(contextFor(row))).pipe(
				Effect.timeoutOrElse({
					duration: Duration.millis(limits.timeoutMs),
					orElse: () =>
						Effect.fail(
							new DataSourceTimeoutError({
								message: `The query did not finish within ${limits.timeoutMs / 1000} seconds`,
								timeoutMs: limits.timeoutMs,
							}),
						),
				}),
			)
			const encoded = yield* encodeJson(table.rows).pipe(
				Effect.mapError(() => persistenceError("Could not measure the query result")),
			)
			if (new TextEncoder().encode(encoded).length > limits.maxBytes) {
				return yield* new DataSourceLimitError({
					message: `The result is larger than ${Math.round(limits.maxBytes / 1_000_000)} MB; select fewer or narrower columns, or aggregate.`,
				})
			}
			if (table.rows.length > limits.maxRows) {
				return yield* new DataSourceLimitError({
					message: `The query returned more than ${limits.maxRows} rows; aggregate or add a LIMIT`,
				})
			}
			yield* Effect.annotateCurrentSpan({ "maple.data_source.rows": table.rows.length })
			return {
				...table,
				language,
				plan: prepared.summary,
				executed: true,
			} satisfies DataSourceQueryResult
		})

		return {
			list,
			get,
			create,
			update,
			remove,
			test,
			refreshCatalog,
			catalog,
			updateCatalogEntry,
			search,
			query,
		} satisfies ExternalDataSourceServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

/** The service with this deployment's drivers, and API sources on the rate-limit bindings' budget. */
export const ExternalDataSourceServiceLive = ExternalDataSourceService.layer.pipe(
	Layer.provide(DataSourceDrivers.fromList(DATA_SOURCE_DRIVERS)),
	Layer.provide(DataSourceCallBudgetLive),
)
