# Effect ClickHouse HTTP

`@maple-dev/effect-clickhouse-http` is an independent workspace package for streaming
ClickHouse queries over HTTP. Its only runtime dependency is Effect 4. It contains
no Maple schema, tenant routing, retry policy, SQL builder, or Node-specific code.
The official ClickHouse web client is a **test-only** dependency for live parity.

## Usage

```ts
import { Config, Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { make } from "@maple-dev/effect-clickhouse-http"

const program = Effect.gen(function* () {
	const password = yield* Config.redacted("CLICKHOUSE_PASSWORD")
	const client = yield* make({
		url: "http://localhost:8123",
		username: "default",
		password,
	})
	const result = yield* client.query({
		sql: "SELECT number FROM numbers(5)",
		settings: { max_execution_time: 30 },
		limits: { maxBytes: 1024, maxRows: 5 },
	})
	yield* Effect.log(result.data)
})

Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)))
```

`make` captures an Effect `HttpClient` and performs no network requests. Provide the
HTTP layer at the application boundary. `query` returns an Effect with `{ data,
queryId }`; `stream` returns an Effect `Stream` of row objects. Both are lazy and
repeatable. An omitted query ID is generated anew for each execution.

Applications with a single endpoint can use the service form instead:
`ClickHouseClient.layer(config)` builds the client from the ambient `HttpClient`, and
`yield* ClickHouseClient` yields the same `Client` that `make` returns.

Pass SQL **without a terminal FORMAT or semicolon**. The client appends a newline
and `FORMAT JSONEachRow`, including when SQL ends in a line comment. Bind or escape
values with your query builder before passing SQL; this transport does not interpolate
parameters. SQL SETTINGS clauses are preserved; per-query settings are sent in URL
parameters. Avoid defining the same setting in both places.

Endpoint paths and ordinary URL parameters are preserved for proxies. Credentials,
fragments, and reserved execution parameters in the endpoint URL are rejected; use
the explicit configuration fields. Authentication uses a UTF-8 Basic authorization
header. The password is an Effect `Redacted` value.

## Streaming and limits

The parser frames rows at the byte level before strict UTF-8 decoding, so chunk
boundaries may fall anywhere, including inside a multibyte character. It accepts
LF, CRLF, empty results, and a complete final row without a trailing newline. It
rejects malformed JSON, non-object rows, invalid UTF-8, and incomplete final rows.

- `maxBytes` counts decompressed network bytes before buffering or JSON parsing,
  including whitespace and exception frames. It is optional.
- `maxRows` is optional and counts decoded rows.
- `maxRowBytes` bounds a single unfinished row; the default is 16 MiB.
- Error responses and exception frames are bounded to 16 KiB.

Limits must be nonnegative safe integers. Zero is meaningful. An incoming network
chunk is already allocated by the HTTP runtime; limits bound what this package
accumulates, not the runtime's own network buffers. Row buffers grow geometrically
rather than retaining one allocation per network fragment.

`query` consumes the whole stream and returns **no partial success** on failure.
`stream` may emit rows before a later server error; consumers must treat a failing
stream as a failed query. Stopping consumption early cannot prove that the server
would have completed successfully.

## Errors and cancellation

The typed error union distinguishes configuration, transport, server, protocol,
redirect, and limit failures. Server errors preserve HTTP status, query ID, and
ClickHouse code/type when available. Transport errors do not retain the HTTP request
or its credentials. Applications remain responsible for redacting server messages
before exposing them: database errors can contain query text or values.

HTTP 200 does not imply query success. The decoder recognizes legacy appended
ClickHouse exceptions and validates the tag, footer, and UTF-8 byte length of modern
exception frames. A complete frame is recognized before waiting for EOF because
ClickHouse may close HTTP chunk framing abruptly after writing an exception.
Malformed or truncated exception frames fail as protocol errors.

The request scope lasts through body consumption. Success, failure, interruption,
and early stream termination close it. Fetch redirects are disabled; injected HTTP
clients must also be configured not to follow redirects. Fetch owns HTTP compression
and decompression; ClickHouse's proprietary compressed binary protocol is unsupported.

Aborting HTTP does **not** guarantee server-side query termination. Set an appropriate
`max_execution_time`; this package does not automatically issue `KILL QUERY`, which
restricted gateways may reject. It performs no retries and does not implement inserts,
DDL helpers, sessions, alternate result formats, or the full official SDK API.

## Tests

```sh
bun run --cwd lib/effect-clickhouse-http typecheck
bun run --cwd lib/effect-clickhouse-http test
CLICKHOUSE_HTTP_URL=http://127.0.0.1:8123 \
CLICKHOUSE_HTTP_USER=maple CLICKHOUSE_HTTP_PASSWORD=maple \
  bun run --cwd lib/effect-clickhouse-http test:live
```

The offline suite checks every two-chunk byte split for representative UTF-8 rows,
legacy errors, framed errors, and errors following partial rows, plus one-byte and
seeded random fragmentation. HTTP tests cover request framing, auth, settings,
redirects, bounded error bodies, cleanup, interruption, and transport failures.

Live tests use only read-only `SELECT`s against ClickHouse system functions. They
compare results with the official client and exercise real server errors, byte limits,
and an exception after HTTP 200. CI runs them against its ClickHouse 26.2 service;
these tests do not establish compatibility with every ClickHouse or gateway version.

Protocol reference: [ClickHouse HTTP interface](https://clickhouse.com/docs/concepts/features/interfaces/http).
