import type {
	CatalogEntryView,
	DataSourceNotFoundError,
	DataSourcePersistenceError,
	DataSourceValidationError,
	CreateExternalDataSourceInput,
	DataSourceConnectionInput,
	ExternalDataSourceDocument,
	UpdateExternalDataSourceInput,
} from "@maple/domain/data-sources"
import {
	DataSourceCatalogEntryNotFoundError,
	DataSourceInvalidError,
	DataSourceNotFoundHttpError,
	DataSourceRateLimitedHttpError,
	DataSourceStorageUnavailableError,
	DataSourceUnreachableError,
} from "@maple/domain/http"
import {
	isoTimestamp,
	isoTimestampOrNull,
	type V2CatalogEntry,
	type V2DataSource,
	type V2DataSourceConnectionParams,
	type V2DataSourceCreateParams,
	type V2DataSourceUpdateParams,
} from "@maple/domain/http/v2"
import type { ExternalDataSourceServiceError } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import { Array as Arr, Effect, String as Str } from "effect"

// Service documents ⇄ the `/v2/data_sources` wire, and service errors → HTTP errors.

export const toV2DataSource = (source: ExternalDataSourceDocument): V2DataSource => ({
	id: source.id,
	object: "data_source",
	name: source.name,
	kind: source.kind,
	query_language: source.queryLanguage,
	description: source.description,
	environment: source.environment,
	tags: source.tags,
	agent_access: source.agentAccess,
	agent_pii: source.agentPii,
	connection:
		source.config._tag === "clickhouse"
			? {
					type: "clickhouse",
					url: source.config.url,
					user: source.config.user,
					database: source.config.database,
				}
			: { type: "clerk", instance: source.config.instance },
	has_secret: source.hasSecret,
	secret_hint: source.secretHint,
	status: source.status,
	last_checked_at: isoTimestampOrNull(source.lastCheckedAt),
	last_error: source.lastError,
	catalog_refreshed_at: isoTimestampOrNull(source.catalogRefreshedAt),
	catalog_error: source.catalogError,
	catalog_entry_count: source.catalogEntryCount,
	created_at: isoTimestamp(source.createdAt),
	updated_at: isoTimestamp(source.updatedAt),
})

export const toV2CatalogEntry = (entry: CatalogEntryView): V2CatalogEntry => ({
	object: "data_source_catalog_entry",
	name: entry.name,
	kind: entry.kind,
	exposed: entry.exposed,
	note: entry.note ?? null,
	row_estimate: entry.rowEstimate ?? null,
	time_field: entry.timeField ?? null,
	fields: Arr.map(entry.fields, (field) => ({
		name: field.name,
		type: field.type,
		native_type: field.nativeType ?? null,
		note: field.note ?? null,
		pii: field.pii === true,
		sample_values: field.sampleValues ?? [],
	})),
})

const toConnectionInput = (connection: V2DataSourceConnectionParams): DataSourceConnectionInput =>
	connection.type === "clickhouse"
		? {
				_tag: "clickhouse",
				url: connection.url,
				user: connection.user,
				database: connection.database,
				...(connection.password === undefined ? undefined : { password: connection.password }),
			}
		: {
				_tag: "clerk",
				...(connection.secret_key === undefined ? undefined : { secretKey: connection.secret_key }),
			}

export const toCreateInput = (params: V2DataSourceCreateParams): CreateExternalDataSourceInput => ({
	name: params.name,
	description: params.description,
	environment: params.environment,
	...(params.tags === undefined ? undefined : { tags: params.tags }),
	...(params.agent_access === undefined ? undefined : { agentAccess: params.agent_access }),
	...(params.agent_pii === undefined ? undefined : { agentPii: params.agent_pii }),
	connection: toConnectionInput(params.connection),
})

export const toUpdateInput = (params: V2DataSourceUpdateParams): UpdateExternalDataSourceInput => ({
	...(params.name === undefined ? undefined : { name: params.name }),
	...(params.description === undefined ? undefined : { description: params.description }),
	...(params.environment === undefined ? undefined : { environment: params.environment }),
	...(params.tags === undefined ? undefined : { tags: params.tags }),
	...(params.agent_access === undefined ? undefined : { agentAccess: params.agent_access }),
	...(params.agent_pii === undefined ? undefined : { agentPii: params.agent_pii }),
	...(params.connection === undefined ? undefined : { connection: toConnectionInput(params.connection) }),
})

/** Whether an update replaced the stored password or key. Recorded in the audit log; the value never is. */
export const secretChanged = (params: V2DataSourceUpdateParams): boolean =>
	params.connection !== undefined &&
	(params.connection.type === "clickhouse"
		? params.connection.password !== undefined
		: params.connection.secret_key !== undefined)

/** Service fields are camelCase (`timeField`); the wire names them in snake_case. */
const wireField = (field: string): string => Str.camelToSnake(field)

const notFound = (error: DataSourceNotFoundError) =>
	Effect.fail(new DataSourceNotFoundHttpError({ message: "No such data source.", rawRef: error.rawRef }))
const storage = (error: DataSourcePersistenceError) =>
	Effect.fail(new DataSourceStorageUnavailableError({ message: error.message }))
const invalidField = (error: DataSourceValidationError) =>
	new DataSourceInvalidError({
		message: error.message,
		...(error.field === undefined ? undefined : { field: wireField(error.field) }),
	})
const invalid = (error: DataSourceValidationError) => Effect.fail(invalidField(error))
const invalidCuration = (error: DataSourceValidationError) =>
	Effect.fail(
		error.field === "entry"
			? new DataSourceCatalogEntryNotFoundError({ message: error.message })
			: invalidField(error),
	)

/** Listing fails only on storage. */
export const mapListErrors = <A, R>(effect: Effect.Effect<A, DataSourcePersistenceError, R>) =>
	effect.pipe(Effect.catchTag("@maple/data-sources/Persistence", storage))

/** Reads, delete and test fail only with a missing source or storage. */
export const mapReadErrors = <A, R>(
	effect: Effect.Effect<A, DataSourceNotFoundError | DataSourcePersistenceError, R>,
) =>
	effect.pipe(
		Effect.catchTags({
			"@maple/data-sources/NotFound": notFound,
			"@maple/data-sources/Persistence": storage,
		}),
	)

/** Catalog curation: a missing entry is a 404 of its own, a bad time field a 400. */
export const mapCurationErrors = <A, R>(
	effect: Effect.Effect<
		A,
		DataSourceNotFoundError | DataSourceValidationError | DataSourcePersistenceError,
		R
	>,
) =>
	effect.pipe(
		Effect.catchTags({
			"@maple/data-sources/NotFound": notFound,
			"@maple/data-sources/Validation": invalidCuration,
			"@maple/data-sources/Persistence": storage,
		}),
	)

/** Writes that reach the source: what the source said is the user's own system, so it is shown. */
export const mapServiceErrors = <A, R>(effect: Effect.Effect<A, ExternalDataSourceServiceError, R>) =>
	effect.pipe(
		Effect.catchTags({
			"@maple/data-sources/NotFound": notFound,
			"@maple/data-sources/Validation": invalid,
			"@maple/data-sources/Persistence": storage,
			"@maple/data-sources/Connection": (error) =>
				Effect.fail(new DataSourceUnreachableError({ message: error.message, reason: error.reason })),
			"@maple/data-sources/Timeout": (error) =>
				Effect.fail(new DataSourceUnreachableError({ message: error.message, reason: "timeout" })),
			"@maple/data-sources/Query": (error) =>
				Effect.fail(new DataSourceUnreachableError({ message: error.message, reason: "query" })),
			"@maple/data-sources/Limit": (error) =>
				Effect.fail(new DataSourceUnreachableError({ message: error.message, reason: "limit" })),
			"@maple/data-sources/RateLimited": (error) =>
				Effect.fail(
					new DataSourceRateLimitedHttpError({
						message: error.message,
						...(error.retryAfterSeconds === undefined
							? undefined
							: { retryAfterSeconds: error.retryAfterSeconds }),
					}),
				),
		}),
	)
