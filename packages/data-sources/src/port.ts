import { Effect, type Redacted } from "effect"
import type { HttpClient } from "effect/http"
import {
	type DataSourceConfig,
	type DataSourceConnectionInput,
	type DataSourceDriverError,
	type DataSourceKind,
	type DataSourceRateLimitedError,
	type DataSourceTable,
	DataSourceValidationError,
	type ExternalDataSourceId,
	type ExternalQuery,
	type QueryLanguage,
	type QueryPlanSummary,
	type SourceCatalog,
} from "@maple/domain/data-sources"

/** A stored source, decrypted, as a driver receives it. */
export interface DriverConnection<C extends DataSourceConfig = DataSourceConfig> {
	readonly sourceId: ExternalDataSourceId
	readonly config: C
	readonly secret: Redacted.Redacted | null
}

/** The half-open time window `[start, end)` a query runs over, in epoch ms. */
export interface QueryWindow {
	readonly startMs: number
	readonly endMs: number
	/** Bucket width for time groups (`$__timeGroup`, resource `groupBy.time`). */
	readonly granularitySeconds: number
}

export type QueryWorkload = "interactive" | "dashboard" | "alert"

export interface QueryLimits {
	readonly maxRows: number
	readonly maxBytes: number
	readonly timeoutMs: number
	/** API sources: most calls one query may make, and most rows a scan may read. */
	readonly maxCalls: number
	readonly maxScanRows: number
}

export interface QueryRequest {
	readonly window: QueryWindow
	readonly limits: QueryLimits
	readonly workload: QueryWorkload
	/** Drop fields the catalog marks PII from the result, and refuse queries that filter or group on them. */
	readonly redactPii: boolean
}

/** What the service hands a running query: Maple's share of the source's rate limit. */
export interface QueryContext {
	/** Takes `calls` from the source's budget, or fails without making them. */
	readonly spend: (calls: number) => Effect.Effect<void, DataSourceRateLimitedError>
}

/** A query the driver has checked and costed; nothing has run yet. */
export interface PreparedQuery {
	readonly summary: QueryPlanSummary
	readonly run: (context: QueryContext) => Effect.Effect<DataSourceTable, DataSourceDriverError, HttpClient.HttpClient>
}

/** Normalized config plus the secret to store; `secret: null` on update keeps the stored one. */
export interface ValidatedConnection<C extends DataSourceConfig = DataSourceConfig> {
	readonly config: C
	readonly secret: string | null
}

export interface ConnectionTest {
	readonly warnings: ReadonlyArray<string>
}

/**
 * One kind of source. Every method that talks to the source needs only an `HttpClient`, which
 * the service provides already checked against private networks.
 */
export interface DataSourceDriver<C extends DataSourceConfig = DataSourceConfig> {
	readonly kind: DataSourceKind
	readonly queryLanguage: QueryLanguage
	/** Form or API input → stored config + secret. `previous` is set on update. */
	readonly validateConnection: (
		input: DataSourceConnectionInput,
		previous: C | null,
	) => Effect.Effect<ValidatedConnection<C>, DataSourceValidationError>
	/** Reaches the source with the stored credentials; warnings are non-fatal (e.g. the role can write). */
	readonly test: (
		connection: DriverConnection<C>,
		context: QueryContext,
	) => Effect.Effect<ConnectionTest, DataSourceDriverError, HttpClient.HttpClient>
	/** SQL sources introspect; API sources return the catalog declared in code. */
	readonly catalog: (
		connection: DriverConnection<C>,
		context: QueryContext,
	) => Effect.Effect<SourceCatalog, DataSourceDriverError, HttpClient.HttpClient>
	/** Checks and costs a query against the stored catalog; refuses what cannot run within the limits. */
	readonly prepare: (
		connection: DriverConnection<C>,
		query: ExternalQuery,
		request: QueryRequest,
		catalog: SourceCatalog,
	) => Effect.Effect<PreparedQuery, DataSourceDriverError>
}

type ConfigOf<K extends DataSourceKind> = Extract<DataSourceConfig, { readonly _tag: K }>

/**
 * Erases a driver's config type so drivers of every kind share one registry. The stored
 * config's tag is checked against the driver's kind on every call, so a row can never reach
 * a driver of another kind with a config it does not understand.
 */
export const registerDriver = <K extends DataSourceKind>(
	driver: DataSourceDriver<ConfigOf<K>> & { readonly kind: K },
): DataSourceDriver => {
	const owns = (config: DataSourceConfig): config is ConfigOf<K> => config._tag === driver.kind
	const narrow = (connection: DriverConnection) =>
		owns(connection.config)
			? Effect.succeed({ ...connection, config: connection.config })
			: Effect.fail(
					new DataSourceValidationError({
						message: `A ${connection.config._tag} source cannot use the ${driver.kind} driver`,
					}),
				)
	return {
		kind: driver.kind,
		queryLanguage: driver.queryLanguage,
		validateConnection: (input, previous) =>
			driver.validateConnection(input, previous !== null && owns(previous) ? previous : null),
		test: (connection, context) => Effect.flatMap(narrow(connection), (c) => driver.test(c, context)),
		catalog: (connection, context) => Effect.flatMap(narrow(connection), (c) => driver.catalog(c, context)),
		prepare: (connection, query, request, catalog) =>
			Effect.flatMap(narrow(connection), (c) => driver.prepare(c, query, request, catalog)),
	}
}
