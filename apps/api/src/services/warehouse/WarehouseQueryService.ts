import * as ClickHouseHttp from "@maple-dev/effect-clickhouse-http"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientError } from "effect/unstable/http"
import { Context, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { WarehouseConfigError, type WarehouseQueryRequest } from "@maple/domain/http"
import {
	BackendDialect,
	makeWarehouseExecutor,
	WarehouseResponseLimitError,
	WarehouseDriverError,
	warehouseHttpClient,
	type ClickHouseProtocolBackendConfig,
	type ExecutionTenant,
	type ResolvedWarehouseConfig,
	type RoutePurpose,
	type SqlQueryOptions,
	type TinybirdBackendConfig,
	type WarehouseExecutorDeps,
	type WarehouseQueryServiceApi,
	type WarehouseRawRouteError,
	type WarehouseResponseLimits,
	type WarehouseRoute,
	type WarehouseSqlClient,
	type WarehouseTrustedRouteError,
} from "@maple/query-engine/execution"
import type { CompiledQueryInput } from "@maple/query-engine/ch"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { Env } from "@/platform/Env"
import type { TenantContext } from "@/services/auth/AuthService"
import { OrgClickHouseSettingsService } from "@/services/org/OrgClickHouseSettingsService"
import { TinybirdOrgTokenService } from "@/services/integrations/TinybirdOrgTokenService"

// WarehouseQueryService — the API's managed-warehouse executor.
//
// The execution logic (SQL run, retry, error mapping, client cache, OrgId
// scoping, span instrumentation) lives in `@maple/query-engine/execution`. This
// file is the host-app wiring: it constructs the actual ClickHouse / Tinybird
// drivers — both on Effect's `HttpClient`, the ClickHouse one through
// `@maple-dev/effect-clickhouse-http` — and resolves the per-org upstream config
// from the DB + env, injecting both into `makeWarehouseExecutor`.
//
// A driver's whole job at this seam is to turn its transport's failures into
// `WarehouseDriverError` with the structure the classifier reads: HTTP status,
// ClickHouse code/type, and a `reason` saying whether the database answered at
// all. Response limits keep their own identity so they never enter the retry loop.

// Re-export the executor types so existing import sites stay stable.
export type { WarehouseQueryServiceApi, SqlQueryOptions }

// `rowBytes` is the native client's per-row ceiling (16 MiB unless a caller
// sets one). Raw SQL caps total bytes at 5 MB, so only a trusted query can
// reach it; it keeps the `bytes` kind but must not be described as the total.
const responseLimitError = (kind: "rows" | "bytes" | "rowBytes", limit: number) =>
	new WarehouseResponseLimitError({
		kind: kind === "rows" ? "rows" : "bytes",
		message:
			kind === "rowBytes"
				? `A single result row exceeded ${limit} encoded bytes`
				: `Raw SQL results may contain at most ${limit} ${kind === "rows" ? "rows" : "encoded bytes"}`,
	})

const clickHouseDriverError = (
	error: ClickHouseHttp.ClickHouseError,
): WarehouseDriverError | WarehouseResponseLimitError => {
	switch (error._tag) {
		case "@effect-clickhouse-http/LimitError":
			return responseLimitError(error.kind, error.limit)
		case "@effect-clickhouse-http/ServerError":
			return new WarehouseDriverError({
				reason: "server",
				status: error.status,
				message: error.message,
				...(error.code === undefined ? undefined : { code: error.code }),
				...(error.type === undefined ? undefined : { type: error.type }),
				cause: error,
			})
		case "@effect-clickhouse-http/TransportError":
			return new WarehouseDriverError({ reason: "transport", message: error.message, cause: error })
		case "@effect-clickhouse-http/ProtocolError":
			return new WarehouseDriverError({
				reason: "protocol",
				status: error.status,
				message: error.message,
				cause: error,
			})
		// A ClickHouse-protocol endpoint answering a query with a redirect is never
		// legitimate, and a BYO cluster's URL is validated when saved, not when
		// used — so a target that passed validation can still answer a query with
		// a 307 into the internal network. The client refuses to follow it; here
		// that is a configuration failure, and the `Location` stays on the cause.
		case "@effect-clickhouse-http/RedirectError":
			return new WarehouseDriverError({
				reason: "config",
				status: error.status,
				message: error.message,
				cause: error,
			})
		case "@effect-clickhouse-http/ConfigError":
			return new WarehouseDriverError({ reason: "config", message: error.message, cause: error })
	}
}

const createClickHouseSqlClient = (
	config: ClickHouseProtocolBackendConfig,
): Effect.Effect<WarehouseSqlClient, WarehouseDriverError, HttpClient.HttpClient> =>
	ClickHouseHttp.make({
		url: config.url,
		username: config.username,
		password: Redacted.make(config.password),
		database: config.database,
		// Wire-format parity with the Tinybird SDK: without this, JSONEachRow quotes
		// 64-bit ints ("count":"42") and every schema-less query leaks strings into
		// Schema.Number responses on BYO-CH orgs. Sent as a per-query URL param, so
		// the compiled SQL text (and its fingerprint) is untouched.
		...(BackendDialect[config.kind].unquote64BitIntegers
			? { settings: { output_format_json_quote_64bit_integers: 0 } }
			: undefined),
	}).pipe(
		Effect.mapError(
			(error) => new WarehouseDriverError({ reason: "config", message: error.message, cause: error }),
		),
		Effect.map(
			(client): WarehouseSqlClient => ({
				// `wireFormat: "out-of-band"` for every ClickHouse-protocol backend: the
				// executor has already stripped any FORMAT clause and the client appends
				// its own.
				// Trusted queries pass no limits, so the client's 16 MiB `maxRowBytes`
				// default still applies: it bounds the buffer a single unfinished row can
				// take and is far above anything a Maple query returns.
				sql: (statement, options) =>
					client
						.query({ sql: statement.text, ...(options?.responseLimits ? { limits: options.responseLimits } : undefined) })
						.pipe(
							Effect.map(({ data }) => ({ data })),
							Effect.mapError(clickHouseDriverError),
						),
				insert: () =>
					// ClickHouse is READ-ONLY for Maple: the managed CLICKHOUSE_URL endpoint is
					// a query gateway that rejects inserts ("Only SELECT or DESCRIBE queries are
					// supported. Got: InsertQuery"), and a BYO org override is a read concern.
					// All ingest goes to Tinybird's Events API (see resolveIngestConfig), so this
					// must never be reached — fail loudly instead of silently 500'ing.
					Effect.fail(
						new WarehouseDriverError({
							reason: "config",
							message: "ClickHouse is read-only for Maple — ingest must use Tinybird",
						}),
					),
			}),
		),
	)

// Tinybird's `/v0/sql` speaks plain HTTP: POST the SQL as text with a bearer
// token, get `{ data: [...] }` back (this backend's dialect is `wireFormat:
// "in-statement"`, so the executor has already put `FORMAT JSON` on the
// statement). Errors come as `{ error: "..." }` with an HTTP status.
const TinybirdSqlResponse = Schema.Struct({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
})
const decodeTinybirdSqlResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TinybirdSqlResponse))
const TinybirdErrorBody = Schema.Struct({ error: Schema.String })
const decodeTinybirdErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(TinybirdErrorBody))

const TINYBIRD_ERROR_BODY_BYTES = 16 * 1024

const tinybirdTransportError = (error: HttpClientError.HttpClientError) =>
	new WarehouseDriverError({
		reason: "transport",
		message: "Tinybird HTTP transport failed",
		// Never retain the request: its Authorization header is the org token.
		cause: "cause" in error.reason ? error.reason.cause : error.reason._tag,
	})

/**
 * Buffer a response body, failing as soon as it exceeds `maxBytes`. Counts
 * network bytes before decoding, so an oversized result is refused without
 * being materialised.
 */
const readBody = <E, E2>(
	body: Stream.Stream<Uint8Array, E>,
	maxBytes: number | undefined,
	onLimit: (maxBytes: number) => E2,
): Effect.Effect<string, E | E2> =>
	body.pipe(
		Stream.runFoldEffect(
			() => ({ chunks: [] as Array<Uint8Array>, total: 0 }),
			(acc, chunk): Effect.Effect<{ chunks: Array<Uint8Array>; total: number }, E2> => {
				const total = acc.total + chunk.byteLength
				if (maxBytes !== undefined && total > maxBytes) return Effect.fail(onLimit(maxBytes))
				acc.chunks.push(chunk)
				return Effect.succeed({ chunks: acc.chunks, total })
			},
		),
		Effect.map(({ chunks, total }) => {
			const bytes = new Uint8Array(total)
			let offset = 0
			for (const chunk of chunks) {
				bytes.set(chunk, offset)
				offset += chunk.byteLength
			}
			return new TextDecoder().decode(bytes)
		}),
	)

/**
 * Buffer at most `maxBytes` of a body and stop pulling; closing the request
 * scope discards the rest. For error bodies, where a truncated message still
 * classifies and an absent one does not.
 */
const readBodyPrefix = <E>(body: Stream.Stream<Uint8Array, E>, maxBytes: number): Effect.Effect<string, E> =>
	Effect.suspend(() => {
		let remaining = maxBytes
		return body.pipe(
			Stream.map((chunk) => {
				const part = chunk.subarray(0, remaining)
				remaining -= part.length
				return part
			}),
			Stream.takeUntil(() => remaining === 0),
			Stream.runCollect,
			Effect.map((parts) => {
				const bytes = new Uint8Array(maxBytes - remaining)
				let offset = 0
				for (const part of parts) {
					bytes.set(part, offset)
					offset += part.length
				}
				return new TextDecoder().decode(bytes)
			}),
		)
	})

const createTinybirdSqlClient = (
	config: TinybirdBackendConfig,
): Effect.Effect<WarehouseSqlClient, never, HttpClient.HttpClient> =>
	Effect.map(HttpClient.HttpClient, (http): WarehouseSqlClient => {
		const base = config.host.replace(/\/$/, "")
		const token = Redacted.make(config.token)
		const bodyOf = (response: { readonly stream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError> }) =>
			response.stream.pipe(
				Stream.catchTag("HttpClientError", (error) =>
					error.reason._tag === "EmptyBodyError" ? Stream.empty : Stream.fail(tinybirdTransportError(error)),
				),
			)
		// Mirrors the SDK's rendering: the JSON `error` field when there is one,
		// otherwise the status and a bounded slice of whatever the body was.
		const serverError = (status: number, body: string) =>
			new WarehouseDriverError({
				reason: "server",
				status,
				message: Option.getOrElse(
					Option.map(decodeTinybirdErrorBody(body), (decoded) => decoded.error),
					() => (body ? `Request failed with status ${status}: ${body.slice(0, 500)}` : `Request failed with status ${status}`),
				),
				cause: body,
			})
		const send = (request: HttpClientRequest.HttpClientRequest) =>
			Effect.gen(function* () {
				const response = yield* HttpClient.withScope(http)
					.execute(HttpClientRequest.bearerToken(request, token))
					.pipe(Effect.mapError(tinybirdTransportError))
				if (response.status >= 200 && response.status < 300) return response
				// Keep the first 16 KiB of an error body: the classifier's message rules
				// still see it, and the rest is discarded with the request scope.
				const body = yield* readBodyPrefix(bodyOf(response), TINYBIRD_ERROR_BODY_BYTES).pipe(
					Effect.orElseSucceed(() => ""),
				)
				return yield* serverError(response.status, body)
			})
		return {
			sql: (statement, options) =>
				Effect.scoped(
					Effect.gen(function* () {
						const limits: WarehouseResponseLimits | undefined = options?.responseLimits
						const response = yield* send(
							HttpClientRequest.post(`${base}/v0/sql`).pipe(
								HttpClientRequest.bodyText(statement.text, "text/plain"),
							),
						)
						const body = yield* readBody(bodyOf(response), limits?.maxBytes, (maxBytes) =>
							responseLimitError("bytes", maxBytes),
						)
						// A 2xx with an empty body is how zero rows can come back; it is a
						// result, not a decode failure.
						if (body.trim() === "") return { data: [] }
						const decoded = yield* decodeTinybirdSqlResponse(body).pipe(
							Effect.mapError(
								(cause) =>
									new WarehouseDriverError({
										reason: "protocol",
										status: response.status,
										message: "Tinybird returned a response that is not a JSON result set",
										cause,
									}),
							),
						)
						if (limits !== undefined && decoded.data.length > limits.maxRows)
							return yield* responseLimitError("rows", limits.maxRows)
						return { data: decoded.data }
					}),
				),
			insert: (datasource, rows) =>
				rows.length === 0
					? Effect.void
					: Effect.scoped(
							Effect.asVoid(
								send(
									HttpClientRequest.post(`${base}/v0/events`).pipe(
										HttpClientRequest.setUrlParams({ name: datasource, wait: "false" }),
										HttpClientRequest.bodyText(
											rows.map((row) => JSON.stringify(row)).join("\n"),
											"application/x-ndjson",
										),
									),
								),
							),
						),
		}
	})

// Driver selection follows `BackendDialect[kind].driver`: the `tinybird` kind is
// the only one on the Events/SQL API; every ClickHouse-protocol kind (gateway,
// BYO/vanilla CH, chdb) uses the ClickHouse HTTP client.
const createClient = (
	config: ResolvedWarehouseConfig,
): Effect.Effect<WarehouseSqlClient, WarehouseDriverError, HttpClient.HttpClient> =>
	config.kind === "tinybird" ? createTinybirdSqlClient(config) : createClickHouseSqlClient(config)

let sqlClientFactory: typeof createClient = createClient

export class WarehouseQueryService extends Context.Service<WarehouseQueryService, WarehouseQueryServiceApi>()(
	"@maple/api/lib/WarehouseQueryService",
	{
		make: Effect.gen(function* () {
			// Captured once: every driver the executor builds runs on this client.
			// `executeSql` is the database span; the drivers' round-trips add none.
			const http = warehouseHttpClient(yield* HttpClient.HttpClient)
			const env = yield* Env
			const orgClickHouseSettings = yield* OrgClickHouseSettingsService
			const orgTokens = yield* TinybirdOrgTokenService

			// The managed (env-level) READ upstream: the Tinybird CH-gateway or vanilla
			// ClickHouse when CLICKHOUSE_URL is set, otherwise the managed Tinybird SDK.
			const resolveManagedConfig = Effect.fn("WarehouseQueryService.resolveManagedConfig")(
				function* () {
					if (Option.isSome(env.CLICKHOUSE_URL)) {
						const configuredUrl = env.CLICKHOUSE_URL.value
						const clickhouseUrl = yield* Effect.try({
							try: () => new URL(configuredUrl),
							catch: () =>
								new WarehouseConfigError({
									pipeName: "resolveManagedConfig",
									message: "CLICKHOUSE_URL is invalid",
								}),
						})
						if (clickhouseUrl.username.length > 0 || clickhouseUrl.password.length > 0) {
							return yield* new WarehouseConfigError({
								pipeName: "resolveManagedConfig",
								message: "CLICKHOUSE_URL must not contain embedded credentials",
							})
						}
						yield* Effect.annotateCurrentSpan("db.client", "clickhouse")
						const kind =
							env.CLICKHOUSE_PROVIDER === "tinybird"
								? ("tinybird-gateway" as const)
								: ("clickhouse" as const)
						return {
							config: {
								kind,
								url: clickhouseUrl.toString().replace(/\/$/, ""),
								username: env.CLICKHOUSE_USER,
								password: Option.match(env.CLICKHOUSE_PASSWORD, {
									onNone: () =>
										kind === "tinybird-gateway" ? Redacted.value(env.TINYBIRD_TOKEN) : "",
									onSome: Redacted.value,
								}),
								database: env.CLICKHOUSE_DATABASE,
							},
							clientCacheKey: "read:managed",
						}
					}

					yield* Effect.annotateCurrentSpan("db.client", "tinybird-sdk")
					return {
						config: {
							kind: "tinybird" as const,
							host: env.TINYBIRD_HOST,
							token: Redacted.value(env.TINYBIRD_TOKEN),
						},
						clientCacheKey: "read:managed",
					}
				},
			)

			/**
			 * The single routing decision: purpose → backend + credentials.
			 *
			 *   ingest → managed Tinybird Events API, always            (source: managed)
			 *   read   → org BYO row? that org's ClickHouse             (source: org-byo)
			 *            else env: tinybird-gateway|clickhouse|tinybird (source: managed)
			 *   raw    → org BYO row? that org's ClickHouse             (source: org-byo)
			 *            managed tinybird/gateway? org-scoped JWT       (source: org-jwt)
			 *            managed vanilla CH? self-hosted mode only      (source: managed)
			 *
			 * Ingest notes (why writes NEVER follow the read routing):
			 * - BILLING: this path bypasses the ingest gateway, where Autumn usage
			 *   metering happens. Today's only `ingest` callers — demo seed, service-map
			 *   rollups, alert checks — are derived/internal/demo data and deliberately
			 *   unmetered. Net-new *customer* telemetry must go through the ingest
			 *   gateway (as the Cloudflare edge-metrics poller does) so it is metered.
			 * - When CLICKHOUSE_URL is set, the managed READ backend is a read-only
			 *   query gateway that rejects inserts ("Only SELECT or DESCRIBE queries
			 *   are supported. Got: InsertQuery"), and a per-org BYO override is a read
			 *   concern. Tinybird is the only writable warehouse (TINYBIRD_HOST/TOKEN
			 *   are required env). Routing writes anywhere else broke demo-seed
			 *   onboarding.
			 *
			 * Raw-SQL isolation invariants (defense-in-depth, preserved verbatim):
			 * BYO creds are already tenant-isolated; shared Tinybird gets a
			 * datasource-scoped org JWT (works through both the SDK and the CH
			 * gateway); a shared vanilla ClickHouse credential has no DB-enforced OrgId
			 * scope, so raw SQL there is allowed only in single-org self-hosted mode.
			 */
			const resolveRouteEffect = Effect.fn("WarehouseQueryService.resolveRoute")(function* (
				tenant: ExecutionTenant,
				purpose: RoutePurpose,
				label: string,
			) {
				yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
				yield* Effect.annotateCurrentSpan("warehouse.route", purpose)

				if (purpose === "ingest") {
					// Legacy attrs, dual-emitted until dashboards move to `warehouse.*`.
					yield* Effect.annotateCurrentSpan("clientSource", "managed")
					yield* Effect.annotateCurrentSpan("query.routing", "ingest")
					yield* Effect.annotateCurrentSpan("db.client", "tinybird-sdk")
					return {
						source: "managed" as const,
						config: {
							kind: "tinybird" as const,
							host: env.TINYBIRD_HOST,
							token: Redacted.value(env.TINYBIRD_TOKEN),
						},
						clientCacheKey: "write:managed",
					}
				}

				// A per-org BYO ClickHouse row (`org_clickhouse_settings`) overrides the
				// managed upstream for that org's reads AND raw SQL (the credentials are
				// already tenant-isolated).
				const override = yield* orgClickHouseSettings.resolveRuntimeConfig(tenant.orgId)
				if (Option.isSome(override)) {
					yield* Effect.annotateCurrentSpan("clientSource", "org_override")
					yield* Effect.annotateCurrentSpan("db.client", "clickhouse")
					return {
						source: "org-byo" as const,
						config: {
							kind: "clickhouse" as const,
							url: override.value.url,
							username: override.value.user,
							password: override.value.password,
							database: override.value.database,
						},
						clientCacheKey: purpose === "raw" ? `raw:${tenant.orgId}` : `read:${tenant.orgId}`,
					}
				}

				yield* Effect.annotateCurrentSpan("clientSource", "managed")
				const managed = yield* resolveManagedConfig()
				if (purpose === "read") return { source: "managed" as const, ...managed }

				// Raw SQL on the shared warehouse needs tenant isolation. Shared Tinybird
				// is isolated with a datasource-scoped JWT; the same token works through
				// both the SDK and Tinybird's ClickHouse-compatible gateway.
				const clientCacheKey = `raw:${tenant.orgId}`
				if (managed.config.kind === "tinybird" || managed.config.kind === "tinybird-gateway") {
					const jwt = yield* orgTokens.getOrgReadToken(tenant.orgId)
					yield* Effect.annotateCurrentSpan("maple.tinybird.token.scope", "org_jwt")
					return {
						source: "org-jwt" as const,
						config:
							managed.config.kind === "tinybird"
								? { ...managed.config, token: jwt }
								: { ...managed.config, password: jwt },
						clientCacheKey,
					}
				}

				// A shared vanilla ClickHouse credential has no database-enforced OrgId
				// scope. It is safe only in Maple's single-org self-hosted deployment mode.
				if (env.MAPLE_AUTH_MODE.toLowerCase() !== "self_hosted") {
					return yield* new WarehouseConfigError({
						pipeName: label,
						message:
							"Raw SQL on managed vanilla ClickHouse is available only in single-org self-hosted mode",
					})
				}
				return { source: "managed" as const, config: managed.config, clientCacheKey }
			})

			function resolveRoute(
				tenant: ExecutionTenant,
				purpose: "read",
				label: string,
			): Effect.Effect<WarehouseRoute, WarehouseTrustedRouteError>
			function resolveRoute(
				tenant: ExecutionTenant,
				purpose: "ingest",
				label: string,
			): Effect.Effect<WarehouseRoute>
			function resolveRoute(
				tenant: ExecutionTenant,
				purpose: "read" | "ingest",
				label: string,
			): Effect.Effect<WarehouseRoute, WarehouseTrustedRouteError>
			function resolveRoute(
				tenant: ExecutionTenant,
				purpose: "raw",
				label: string,
			): Effect.Effect<WarehouseRoute, WarehouseRawRouteError>
			function resolveRoute(
				tenant: ExecutionTenant,
				purpose: RoutePurpose,
				label: string,
			): Effect.Effect<WarehouseRoute, WarehouseRawRouteError>
			function resolveRoute(
				tenant: ExecutionTenant,
				purpose: RoutePurpose,
				label: string,
			): Effect.Effect<WarehouseRoute, WarehouseRawRouteError> {
				return resolveRouteEffect(tenant, purpose, label)
			}

			// Credential-rotation self-heal. `resolveRuntimeConfig` answers from a
			// stale-tolerant memo, so a rotated BYO ClickHouse password keeps resolving
			// to the retired credential until the entry ages out; the executor calls
			// this on `WarehouseAuthError` and retries once. The boolean it returns is
			// the retry gate — `false` for managed orgs, where re-resolving would
			// produce the same shared credential that just failed.
			const invalidateRoute: NonNullable<WarehouseExecutorDeps["invalidateRoute"]> = (tenant) =>
				orgClickHouseSettings.invalidateRuntimeConfig(tenant.orgId)

			return makeWarehouseExecutor({
				createClient: (config) =>
					sqlClientFactory(config).pipe(Effect.provideService(HttpClient.HttpClient, http)),
				resolveRoute,
				invalidateRoute,
			})
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))

	static readonly query = (
		tenant: TenantContext,
		payload: WarehouseQueryRequest,
		options?: SqlQueryOptions,
	) => this.use((service) => service.query(tenant, payload, options))

	static readonly compiledQuery = <T>(
		tenant: TenantContext,
		compiled: CompiledQueryInput<T>,
		options?: SqlQueryOptions,
	) => this.use((service) => service.compiledQuery(tenant, compiled, options))

	/**
	 * `compiledQuery` with a hard ceiling on the response we'll materialize.
	 * Fails with `WarehouseResponseLimitError` past it rather than buffering the
	 * rest into the Worker heap — for queries whose result size follows user data
	 * rather than the query shape (session-replay rrweb payloads).
	 */
	static readonly compiledQueryBounded = <T>(
		tenant: TenantContext,
		compiled: CompiledQueryInput<T>,
		options: SqlQueryOptions & {
			readonly responseLimits: { readonly maxRows: number; readonly maxBytes: number }
		},
	) => this.use((service) => service.compiledQueryBounded(tenant, compiled, options))

	static readonly compiledQueryFirst = <T>(
		tenant: TenantContext,
		compiled: CompiledQueryInput<T>,
		options?: SqlQueryOptions,
	) => this.use((service) => service.compiledQueryFirst(tenant, compiled, options))

	static readonly ingest = <T>(tenant: TenantContext, datasource: string, rows: ReadonlyArray<T>) =>
		this.use((service) => service.ingest(tenant, datasource, rows))
}

/**
 * Provides the package-level `WarehouseExecutor` for a tenant from the
 * request's existing `WarehouseQueryService`. The executor is a pure facade,
 * so installing the service directly avoids constructing a request-local
 * Layer (and the extra scope that comes with it).
 */
export const provideWarehouseExecutorFromTenant = (tenant: TenantContext) =>
	Effect.provideServiceEffect(
		WarehouseExecutor,
		Effect.map(WarehouseQueryService, (warehouse) => warehouse.asExecutor(tenant)),
	)

export const __testables = {
	setClientFactory: (factory: typeof createClient) => {
		sqlClientFactory = factory
	},
	reset: () => {
		sqlClientFactory = createClient
	},
	createClickHouseSqlClient,
	createTinybirdSqlClient,
}
