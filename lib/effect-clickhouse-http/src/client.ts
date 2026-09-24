import { Context, Effect, Encoding, Layer, Option, Redacted, type Scope, Stream, type Types } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import {
	ClickHouseConfigError,
	ClickHouseRedirectError,
	ClickHouseTransportError,
	serverError,
	type ClickHouseError,
} from "./errors"
import { decodeRows, type Limits } from "./protocol"

export interface ClientConfig {
	/** HTTP(S) endpoint; proxy paths and ordinary URL parameters are preserved. */
	readonly url: string
	readonly database?: string
	readonly username?: string
	readonly password?: Redacted.Redacted<string>
	readonly settings?: Readonly<Record<string, string | number>>
}
export interface QueryOptions {
	/** SQL without a terminal FORMAT or semicolon. Values must already be safely bound. */
	readonly sql: string
	readonly queryId?: string
	readonly settings?: Readonly<Record<string, string | number>>
	readonly limits?: Limits
}
export type Row = Record<string, unknown>
export interface QueryResult {
	readonly data: ReadonlyArray<Row>
	readonly queryId: string
}
export interface Client {
	/** Emits rows as they arrive. A later failure invalidates the overall query. */
	readonly stream: (options: QueryOptions) => Stream.Stream<Row, ClickHouseError>
	/** Collects all rows, returning no partial result on any failure. */
	readonly query: (options: QueryOptions) => Effect.Effect<QueryResult, ClickHouseError>
}

/** A response whose headers have arrived; `rows` is bound to the enclosing request scope. */
interface OpenQuery {
	readonly queryId: string
	readonly rows: Stream.Stream<Row, ClickHouseError>
}

const reserved = new Set(["query", "query_id", "database", "user", "password", "default_format"])
const validSettings = (settings: ClientConfig["settings"]) =>
	Object.entries(settings ?? {}).every(
		([key, value]) =>
			/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) &&
			!reserved.has(key) &&
			(typeof value === "string" || Number.isFinite(value)),
	)
const validLimits = (limits: Limits | undefined) =>
	Object.values(limits ?? {}).every((n) => n === undefined || (Number.isSafeInteger(n) && n >= 0))

const transportError = (error: { readonly reason: object }, queryId: string) =>
	new ClickHouseTransportError({
		queryId,
		message: "ClickHouse HTTP transport failed",
		// Do not retain the HTTP request: it contains credentials and SQL.
		cause: "cause" in error.reason ? error.reason.cause : undefined,
	})

/** Read at most 16 KiB of an error response, then close the request scope. */
const errorText = <E, R>(body: Stream.Stream<Uint8Array, E, R>) =>
	Effect.suspend(() => {
		let remaining = 16 * 1024
		return body.pipe(
			Stream.map((chunk) => {
				const part = chunk.subarray(0, remaining)
				remaining -= part.length
				return part
			}),
			Stream.takeUntil(() => remaining === 0),
			Stream.runCollect,
			Effect.map((parts) => {
				const bytes = new Uint8Array(16 * 1024 - remaining)
				let offset = 0
				for (const part of parts) {
					bytes.set(part, offset)
					offset += part.length
				}
				return new TextDecoder().decode(bytes)
			}),
		)
	})

/** Captures the supplied Effect HTTP client. This constructor performs no network requests. */
export const make = (
	config: ClientConfig,
): Effect.Effect<Client, ClickHouseConfigError, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const endpoint = yield* Effect.try({
			try: () => new URL(config.url),
			catch: () =>
				new ClickHouseConfigError({ message: "ClickHouse endpoint must be an absolute HTTP(S) URL" }),
		})
		if (
			!/^https?:$/.test(endpoint.protocol) ||
			endpoint.username ||
			endpoint.password ||
			endpoint.hash ||
			[...endpoint.searchParams.keys()].some((key) => reserved.has(key)) ||
			!validSettings(config.settings) ||
			(config.username ?? "default").includes(":")
		) {
			return yield* new ClickHouseConfigError({
				message: "Invalid ClickHouse endpoint, credentials, or settings",
			})
		}
		const http = yield* HttpClient.HttpClient
		// UTF-8 Basic auth: `HttpClientRequest.basicAuth` goes through `btoa`, which
		// rejects anything outside Latin-1 and mis-encodes what it accepts.
		const authorization = `Basic ${Encoding.encodeBase64(
			`${config.username ?? "default"}:${config.password ? Redacted.value(config.password) : ""}`,
		)}`

		const open = (
			options: QueryOptions,
			queryId: string,
		): Effect.Effect<OpenQuery, ClickHouseError, Scope.Scope> =>
			Effect.gen(function* () {
				if (
					!options.sql.trim() ||
					!validSettings(options.settings) ||
					!validLimits(options.limits) ||
					!queryId ||
					/[\r\n\0]/.test(queryId)
				) {
					return yield* new ClickHouseConfigError({
						message: "Invalid ClickHouse query, settings, limits, or query ID",
					})
				}
				const url = new URL(endpoint)
				url.searchParams.set("database", config.database ?? "default")
				url.searchParams.set("query_id", queryId)
				for (const [key, value] of Object.entries({ ...config.settings, ...options.settings }))
					url.searchParams.set(key, String(value))
				const request = HttpClientRequest.post(url).pipe(
					HttpClientRequest.setHeader("authorization", authorization),
					HttpClientRequest.bodyText(`${options.sql}\nFORMAT JSONEachRow`, "text/plain; charset=utf-8"),
				)
				// The scope spans body consumption, not just response headers. Never follow
				// redirects with database credentials, including with FetchHttpClient defaults.
				const fetchOptions = yield* Effect.serviceOption(FetchHttpClient.RequestInit)
				const response = yield* HttpClient.withScope(http)
					.execute(request)
					.pipe(
						Effect.provideService(FetchHttpClient.RequestInit, {
							...Option.getOrElse(fetchOptions, () => ({})),
							redirect: "manual",
						}),
						Effect.mapError((error) => transportError(error, queryId)),
					)
				const id = response.headers["x-clickhouse-query-id"] || queryId
				const info = { status: response.status, queryId: id }
				if ((response.status >= 300 && response.status < 400) || response.status === 0) {
					const details: Types.Mutable<ConstructorParameters<typeof ClickHouseRedirectError>[0]> = {
						...info,
						message: `ClickHouse redirect responses are not allowed (${response.status})`,
					}
					if (response.headers.location !== undefined) details.location = response.headers.location
					return yield* new ClickHouseRedirectError(details)
				}
				const body = response.stream.pipe(
					Stream.catchTag("HttpClientError", (error) =>
						error.reason._tag === "EmptyBodyError" ? Stream.empty : Stream.fail(transportError(error, id)),
					),
				)
				const exceptionCode = response.headers["x-clickhouse-exception-code"]
				if (response.status < 200 || response.status >= 300 || exceptionCode !== undefined) {
					const text = yield* errorText(body)
					return yield* serverError(text, response.status, id, exceptionCode)
				}
				return {
					queryId: id,
					rows: decodeRows(
						body,
						{ ...info, exceptionTag: response.headers["x-clickhouse-exception-tag"] },
						options.limits ?? {},
					),
				}
			})
		// A fresh ID per execution: the same lazy Effect can run many times.
		const openWithId = (options: QueryOptions) =>
			Effect.suspend(() => open(options, options.queryId ?? crypto.randomUUID()))

		return {
			stream: (options) => Stream.unwrap(Effect.map(openWithId(options), (query) => query.rows)),
			query: (options) =>
				Effect.scoped(
					Effect.flatMap(openWithId(options), (query) =>
						Effect.map(Stream.runCollect(query.rows), (data) => ({ data, queryId: query.queryId })),
					),
				),
		}
	})

/**
 * Service form for applications with one endpoint: `ClickHouseClient.layer(config)`
 * builds the client from the ambient `HttpClient`. Multi-endpoint applications call
 * `make` per endpoint instead.
 */
export class ClickHouseClient extends Context.Service<ClickHouseClient, Client>()(
	"@effect-clickhouse-http/ClickHouseClient",
) {
	static readonly layer = (
		config: ClientConfig,
	): Layer.Layer<ClickHouseClient, ClickHouseConfigError, HttpClient.HttpClient> =>
		Layer.effect(ClickHouseClient, make(config))
}
