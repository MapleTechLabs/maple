// Shared client for the local Maple server's `POST /local/query` endpoint, used
// by both the browser SPA (`apps/local-ui`) and the query CLI (`apps/cli`).
// The endpoint runs raw SQL through the in-process chDB session and returns a
// bare JSON array.
//
// The output FORMAT is owned by the server: `forceJsonEachRow` in
// `apps/cli/src/server/serve.ts` strips whatever trailing `FORMAT <fmt>` the
// compiler emitted (`CH.compile(...)` appends `FORMAT JSON`) and re-runs the
// query as `FORMAT JSONEachRow`. So callers POST `compiled.sql` verbatim.

import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"

/**
 * The local server refused the query. Its own tag, and structured fields, so
 * callers stop re-deriving the cause from the rendered sentence: `status` is
 * the HTTP status, `detail` the server's body, and `code`/`type` the chDB error
 * identity lifted out of it (`60` / `UNKNOWN_TABLE`).
 */
export class LocalQueryFailed extends Schema.TaggedError<LocalQueryFailed>()(
	"@maple/query-engine/LocalQueryFailed",
	{
		status: Schema.Number,
		detail: Schema.String,
		code: Schema.optionalKey(Schema.String),
		type: Schema.optionalKey(Schema.String),
		message: Schema.String,
	},
) {}

/** The server answered 2xx with something that was not the documented JSON array. */
export class LocalQueryMalformedResponse extends Schema.TaggedError<LocalQueryMalformedResponse>()(
	"@maple/query-engine/LocalQueryMalformedResponse",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** The request never reached a response: the binary is down, or the socket dropped. */
export class LocalQueryUnreachable extends Schema.TaggedError<LocalQueryUnreachable>()(
	"@maple/query-engine/LocalQueryUnreachable",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

export type LocalQueryError = LocalQueryFailed | LocalQueryMalformedResponse | LocalQueryUnreachable

export type LocalQueryRow = Record<string, unknown>

const LocalQueryRows = Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
const decodeRows = Schema.decodeUnknownEffect(LocalQueryRows)

/**
 * Execute compiled SQL against the local Maple binary and return the rows.
 *
 * Lazy and interruptible: the request is bound to a scope that closes with
 * success, failure, or interruption, so a cancelled caller aborts the HTTP
 * request instead of leaving chDB working on a result nobody reads.
 *
 * @param sql      The compiled SQL (e.g. from `CH.compile(...).sql`), sent as-is.
 * @param baseUrl  Origin of the local binary. Defaults to `""` (a relative
 *                 `/local/query`, for the SPA behind its vite proxy); the CLI
 *                 passes an absolute address like `http://127.0.0.1:4318`.
 */
export const executeLocalQuery = (
	sql: string,
	baseUrl = "",
): Effect.Effect<ReadonlyArray<LocalQueryRow>, LocalQueryError, HttpClient.HttpClient> =>
	Effect.scoped(
		Effect.gen(function* () {
			const http = yield* HttpClient.HttpClient
			const request = HttpClientRequest.post(`${baseUrl}/local/query`).pipe(
				HttpClientRequest.bodyText(JSON.stringify({ sql }), "application/json"),
			)
			const response = yield* HttpClient.withScope(http)
				.execute(request)
				.pipe(
					Effect.mapError(
						(cause) =>
							new LocalQueryUnreachable({ message: "Local Maple server is unreachable", cause }),
					),
				)
			if (response.status < 200 || response.status >= 300) {
				const detail = (yield* response.text.pipe(Effect.orElseSucceed(() => ""))).trim()
				return yield* new LocalQueryFailed({
					status: response.status,
					detail,
					// `code`/`type` are what `mapWarehouseError` classifies on. Lifting them
					// here lets the classifier see `UNKNOWN_TABLE` instead of regex-matching
					// the rendered sentence.
					...clickHouseErrorFields(detail),
					message: `Local query failed (${response.status})${detail ? `: ${detail}` : ""}`,
				})
			}
			const json = yield* response.json.pipe(
				Effect.mapError(
					(cause) =>
						new LocalQueryMalformedResponse({ message: "Local query response was not JSON", cause }),
				),
			)
			return yield* decodeRows(json).pipe(
				Effect.mapError(
					(cause) =>
						new LocalQueryMalformedResponse({
							message: "Local query response was not a JSON array of rows",
							cause,
						}),
				),
			)
		}),
	)

/**
 * Promise edge for the SPA's hooks, which hand TanStack Query an `AbortSignal`.
 * Runs `executeLocalQuery` on the platform `fetch`; aborting the signal
 * interrupts the fiber, which aborts the request.
 */
export const runLocalQuery = (
	sql: string,
	baseUrl = "",
	signal?: AbortSignal,
): Promise<ReadonlyArray<LocalQueryRow>> =>
	// This is the SPA's entry point into Effect: each call is its own root, so
	// the fetch layer is provided here rather than composed higher up.
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.runPromise(executeLocalQuery(sql, baseUrl).pipe(Effect.provide(FetchHttpClient.layer)), { signal })

/**
 * chDB renders its failures as `query failed: Code: 60. DB::Exception: … (UNKNOWN_TABLE)`.
 * Lift the numeric code and the symbolic type out of that text so the error
 * carries them as fields.
 */
type ChdbErrorIdentity = { code?: string; type?: string }

const clickHouseErrorFields = (detail: string): ChdbErrorIdentity => {
	// Assigned rather than spread conditionally: both are `optionalKey`, so an
	// explicit `undefined` is not the same as an absent key.
	const fields: ChdbErrorIdentity = {}
	const code = detail.match(/\bCode:\s*(\d+)/)?.[1]
	if (code !== undefined) fields.code = code
	// The type is the trailing parenthesised SCREAMING_CASE token; chDB puts it
	// last, after the human sentence.
	const type = detail.match(/\(([A-Z][A-Z0-9_]{2,})\)\s*$/)?.[1]
	if (type !== undefined) fields.type = type
	return fields
}
