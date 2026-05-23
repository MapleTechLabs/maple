/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Utilities for representing, validating, parsing, and serializing HTTP cookies.
 *
 * This module provides an immutable `Cookies` collection keyed by cookie name,
 * constructors for validated `Cookie` values, and helpers for common server and
 * client flows such as reading `Cookie` request headers, emitting `Set-Cookie`
 * response headers, merging cookie sets, and expiring cookies.
 *
 * Cookie parsing is intentionally tolerant of malformed input: unsupported or
 * invalid `Set-Cookie` attributes are ignored, values are percent-decoded on a
 * best-effort basis, and collections keep one cookie per name. Security
 * attributes such as `HttpOnly`, `Secure`, `SameSite`, and `Partitioned` are
 * serialized when present, but browsers enforce their final behavior, so set
 * them explicitly for session, cross-site, and HTTPS-sensitive cookies.
 *
 * @since 4.0.0
 */
export * as Cookies from "./Cookies.ts"

/**
 * Utilities for representing and generating HTTP entity tags.
 *
 * ETags are validators that identify a particular representation of a
 * resource. Servers commonly attach them to responses so clients and
 * intermediaries can revalidate cached content with conditional requests such
 * as `If-None-Match`, or protect updates with preconditions such as `If-Match`.
 *
 * This module models weak and strong ETags, formats them for the `ETag` header,
 * and provides generator layers that derive tags from file size and
 * modification-time metadata. Metadata-derived tags are convenient for static
 * files, but they are only as precise as the underlying metadata: choose strong
 * tags only when that metadata reliably changes for every byte-level change,
 * and use weak tags when the validator is suitable for cache revalidation but
 * not for operations that require byte-for-byte identity.
 *
 * @since 4.0.0
 */
export * as Etag from "./Etag.ts"

/**
 * Provides an `HttpClient` implementation backed by the Web Fetch API.
 *
 * Use this module when an application should run HTTP requests through the
 * platform's `fetch` implementation, such as browser code, edge runtimes, or
 * Node.js environments that provide `globalThis.fetch`. The `Fetch` reference
 * allows tests and custom runtimes to supply a different fetch function, while
 * `RequestInit` can provide defaults such as credentials, redirect behavior,
 * cache mode, or other platform-specific fetch options.
 *
 * The client translates Effect HTTP requests into fetch calls and wraps Web
 * `Response` values as `HttpClientResponse`s. Fetch implementations control
 * details such as CORS, cookies, redirect handling, and abort semantics, so
 * behavior can vary by platform. Stream request bodies are sent as Web streams
 * with `duplex: "half"` for runtimes that require it, and `content-length` is
 * omitted so fetch can manage body framing itself.
 *
 * @since 4.0.0
 */
export * as FetchHttpClient from "./FetchHttpClient.ts"

/**
 * @since 4.0.0
 */
export * as FindMyWay from "./FindMyWay.ts"

/**
 * Utilities for representing and transforming HTTP headers.
 *
 * This module provides an immutable `Headers` collection for request and
 * response metadata, along with constructors and combinators for common header
 * workflows such as reading values, checking for presence, setting or merging
 * header sets, removing names, and redacting sensitive headers before
 * inspection.
 *
 * Header names are normalized to lowercase by the safe constructors and
 * lookups, matching HTTP's case-insensitive header-name semantics. Each stored
 * header name maps to a single string value: array values in record input are
 * joined with `", "`, iterable input keeps the last value for duplicate names,
 * and later values override earlier ones when setting or merging. Be careful
 * with headers that require distinct field lines, such as `set-cookie`, because
 * this representation does not preserve multiple values separately.
 *
 * @since 4.0.0
 */
export * as Headers from "./Headers.ts"

/**
 * Utilities and data types for describing outgoing HTTP body content.
 *
 * This module provides a small set of `HttpBody` variants used by HTTP client
 * requests and server responses: empty bodies, raw runtime values, in-memory
 * bytes, `FormData`, and byte streams. Constructors cover the common cases of
 * text, JSON, URL-encoded forms, multipart forms, and files while carrying the
 * content type and, when known, the content length used by platform adapters.
 *
 * Streaming bodies are represented as streams of `Uint8Array` chunks and may
 * omit `contentLength` when the size is not known ahead of time. Multipart
 * `FormData` intentionally leaves `contentType` unset so the runtime can add
 * the required boundary; setting that header manually can produce invalid
 * requests.
 *
 * @since 4.0.0
 */
export * as HttpBody from "./HttpBody.ts"

/**
 * Composable HTTP client service for executing `HttpClientRequest` values and
 * receiving `HttpClientResponse` values inside Effect programs.
 *
 * This module provides the `HttpClient` service tag, method-specific accessors,
 * constructors for low-level runtimes, and middleware-style combinators for
 * common client concerns such as request rewriting, response filtering, retries,
 * redirects, cookies, rate limiting, and tracing. It is intended for code that
 * needs dependency-injected outbound HTTP calls, reusable clients customized for
 * an API, or cross-cutting behavior layered around a concrete platform client.
 *
 * Responses are successful Effects even for non-2xx status codes unless a
 * filter such as `filterStatus` or `filterStatusOk` is applied. Request
 * middleware is ordered by whether it prepends to or appends after the existing
 * preprocessing pipeline, so use `mapRequestInput` for transformations that
 * should run before previously installed request middleware and `mapRequest`
 * for transformations that should run after it. Non-scoped responses are tied to
 * an abort controller for interruption cleanup; use `withScope` when the request
 * lifetime should instead be controlled by a surrounding `Scope`.
 *
 * @since 4.0.0
 */
export * as HttpClient from "./HttpClient.ts"

/**
 * Error types used by the HTTP client to describe failures that occur while
 * preparing requests, sending them, validating response status codes, and
 * decoding response bodies.
 *
 * The module exposes the `HttpClientError` wrapper together with the specific
 * reason classes it can carry, so applications can either handle all HTTP
 * client failures uniformly or branch on the exact `_tag` for retries, logging,
 * metrics, and user-facing messages. A common gotcha is that only response
 * errors carry an `HttpClientResponse`: transport, encoding, and invalid URL
 * failures happen before a response is available, while status-code, decode, and
 * empty-body failures preserve the response that triggered them.
 *
 * @since 4.0.0
 */
export * as HttpClientError from "./HttpClientError.ts"

/**
 * Utilities for constructing immutable outgoing HTTP client requests.
 *
 * This module models the request data passed to HTTP clients and adapters:
 * method, URL, query parameters, hash, headers, and body. It provides
 * method-specific constructors, pipeable combinators for adding authentication
 * headers and accepted media types, helpers for JSON, form, stream, and file
 * bodies, and conversions to and from the Web `Request` type.
 *
 * Request construction keeps the base URL, query parameters, and hash as
 * separate fields until conversion. Passing a `URL` extracts its search
 * parameters and fragment into those structured fields, while string URLs are
 * kept as provided. Use the `setUrlParam` helpers when replacing query values
 * and the `appendUrlParam` helpers when multiple values for the same key should
 * be preserved. Setting a body also updates `Content-Type` and
 * `Content-Length` from the body metadata when available; `FormData` leaves
 * those headers to the runtime so multipart boundaries can be generated
 * correctly.
 *
 * @since 4.0.0
 */
export * as HttpClientRequest from "./HttpClientRequest.ts"

/**
 * Utilities for inspecting, decoding, and filtering HTTP client responses.
 *
 * An `HttpClientResponse` pairs the platform `Response` with the request that
 * produced it, exposing status, headers, cookies, and effectful views of the
 * response body. Use this module after an `HttpClient` call to branch on status
 * with `matchStatus` or `filterStatus`, decode JSON or URL-encoded bodies with
 * schemas, stream bytes, or adapt a Web `Response` with `fromWeb`.
 *
 * Response bodies come from the underlying Web response and should be decoded
 * deliberately: `json` parses an empty text body as `null`, body readers fail
 * with `HttpClientError` when decoding fails, and the raw stream fails when no
 * body is present. Headers are represented by the HTTP `Headers` module's
 * single-value, lowercase map, while response cookies are parsed separately from
 * `Set-Cookie` headers. Status values are not considered errors by themselves;
 * use the provided filters or matchers when only specific status codes are
 * acceptable.
 *
 * @since 4.0.0
 */
export * as HttpClientResponse from "./HttpClientResponse.ts"

/**
 * Utilities for running HTTP server effects at the boundary between Effect and
 * platform request handlers.
 *
 * This module is used to turn an effect that produces an `HttpServerResponse`
 * into a concrete handler, such as a Web `Request` handler, while applying
 * middleware, converting failures into HTTP responses, and preserving the
 * current `HttpServerRequest` in the Effect context. It also provides hooks for
 * adjusting a response immediately before it is sent and helpers for managing
 * the request `Scope`, especially when a streaming response must own that scope
 * until the stream completes.
 *
 * Handlers built here expect the per-request context to contain
 * `HttpServerRequest` and, for scoped resources, `Scope.Scope`. Failures are
 * reported and translated through `HttpServerError` / respondable conversions,
 * so unhandled defects generally become server error responses while request
 * aborts and already-sent responses need to be handled with the provided
 * middleware and scope utilities.
 *
 * @since 4.0.0
 */
export * as HttpEffect from "./HttpEffect.ts"

/**
 * Shared utilities for reading and decoding incoming HTTP messages.
 *
 * `HttpIncomingMessage` is the common body-and-header surface used by HTTP
 * server requests and client responses. It keeps transport-specific metadata in
 * the surrounding request and response modules while this module focuses on
 * headers, optional remote address information, byte streams, buffered body
 * views, and schema decoders for JSON bodies, URL-encoded bodies, and headers.
 *
 * Use these helpers in middleware, route handlers, client response processing,
 * and adapters when code should work with any incoming message instead of a
 * concrete request or response type. Body access is effectful because reading,
 * parsing, and decoding can fail; use `stream` when bytes should stay
 * streaming, and use `text`, `json`, `urlParamsBody`, or `arrayBuffer` when a
 * buffered view is appropriate. Some runtimes expose bodies as one-shot Web
 * streams, so prefer one body representation per message and let each
 * implementation's cached accessors handle repeated reads where available.
 *
 * Headers use the HTTP `Headers` module's lowercase, single-value map, so
 * repeated values may already have been combined or normalized by the adapter.
 * Decode headers with `schemaHeaders` when their shape matters. For form
 * bodies, `urlParamsBody` handles URL-encoded payloads; multipart support lives
 * on `HttpServerRequest`, with `MaxBodySize` providing the shared limit
 * reference used by multipart parsing.
 *
 * @since 4.0.0
 */
export * as HttpIncomingMessage from "./HttpIncomingMessage.ts"

/**
 * Defines the supported HTTP method literals shared by the unstable HTTP client,
 * server, and routing APIs.
 *
 * Use this module when constructing method-specific requests, matching incoming
 * requests, validating unknown method values, or deriving method helper names.
 * Methods are represented as uppercase string literals, so values such as `"get"`
 * are not accepted as `HttpMethod` values.
 *
 * The body classification is intentionally conservative and file-specific:
 * `GET`, `HEAD`, `OPTIONS`, and `TRACE` are modeled as bodyless methods, while
 * `POST`, `PUT`, `DELETE`, and `PATCH` are modeled as methods that can carry a
 * request body. This means `DELETE` is allowed to carry a body even though some
 * servers and intermediaries may ignore it, and `GET` request bodies are not
 * represented by these helpers even though the wire protocol does not strictly
 * forbid them.
 *
 * @since 4.0.0
 */
export * as HttpMethod from "./HttpMethod.ts"

/**
 * Server-side HTTP middleware for wrapping `HttpServerResponse` effects with
 * cross-cutting request and response behavior.
 *
 * A middleware is a function from one HTTP server app effect to another. The app
 * is evaluated with the current `HttpServerRequest` service in its context, so
 * middleware in this module can inspect or rewrite the request, provide
 * request-scoped services, attach pre-response hooks, or observe the app exit
 * while preserving normal Effect error and interruption semantics.
 *
 * Use this module for common server concerns such as access logging, trace span
 * creation, trusting forwarded proxy headers, parsing search parameters, and
 * adding CORS handling. Middleware can be applied directly when serving an
 * `HttpServer` / `HttpEffect` app or registered through `HttpRouter.middleware`
 * for route-scoped or global behavior.
 *
 * Middleware composition is order-sensitive, and each middleware may change the
 * wrapped effect's requirements or error channel. These functions expect a
 * per-request `HttpServerRequest` to be present; context-providing middleware
 * should wrap handlers before they access the provided service, and
 * error-handling middleware should be installed where its transformed error type
 * matches the surrounding app or router registration.
 *
 * @since 4.0.0
 */
export * as HttpMiddleware from "./HttpMiddleware.ts"

/**
 * Platform-specific support for serving files as HTTP server responses.
 *
 * `HttpPlatform` is the boundary between the portable HTTP response model and
 * the runtime that knows how to stream bytes from the host platform. Server
 * code uses this service when it needs to return local files, static assets,
 * downloads, byte ranges, or Web `File`-like values without constructing the
 * response body by hand.
 *
 * The helpers in this module enrich those responses with file metadata such as
 * `etag`, `last-modified`, and content length where available. Path-based
 * responses require `FileSystem` and can fail with `PlatformError` while
 * inspecting or streaming the file; `File`-like responses use the Web
 * `ReadableStream` and `lastModified` metadata exposed by the value.
 *
 * Provide `layer` when the default streaming implementation is suitable, or
 * use `make` to plug in a runtime-specific response constructor. The default
 * layer supplies weak ETag generation itself, but the surrounding runtime still
 * needs to provide the `FileSystem` service and run the resulting
 * `HttpServerResponse` on an HTTP server adapter that understands Effect
 * streams.
 *
 * @since 4.0.0
 */
export * as HttpPlatform from "./HttpPlatform.ts"

/**
 * Layer-based server-side HTTP routing for Effect applications.
 *
 * This module provides the `HttpRouter` service and helpers for registering
 * method/path handlers, grouping routes under prefixes, decoding request
 * schemas from route and search parameters, and turning an application layer
 * into an `HttpServer` or Fetch-compatible handler. It is intended for HTTP
 * APIs, webhooks, and other server endpoints that want request-scoped services
 * and typed middleware to be composed through `Layer`.
 *
 * Route paths must be absolute paths beginning with `/`, or the wildcard `*`.
 * Prefixed routes remove the matched prefix from the request URL seen by the
 * handler, `HEAD` requests fall back to matching `GET` routes, and wildcard
 * paths ending in `/*` also match the prefix path itself. Use router middleware
 * when you need to provide request dependencies, handle configured route errors,
 * or modify route responses; server middleware wraps the wider server chain and
 * is not the right hook for changing the final response body or headers.
 *
 * @since 4.0.0
 */
export * as HttpRouter from "./HttpRouter.ts"

/**
 * Service and helpers for running Effect HTTP applications on a concrete server
 * runtime.
 *
 * This module defines the `HttpServer` service tag used by platform integrations
 * to expose a listening server, plus accessors for serving an
 * `HttpServerResponse` effect, formatting and logging server addresses, and
 * building test clients against a running server. It is intended for low-level
 * server runtimes, router integrations, HTTP API tests, and applications that
 * need to start serving from a provided `Layer`.
 *
 * The server supplies `HttpServerRequest` for each request, so application
 * effects should rely on the server for request-scoped data while still
 * providing their other services through the surrounding environment. `serve`
 * returns a `Layer` whose listener lifetime is managed by the layer scope; use
 * `serveEffect` when composing directly in an effect with an explicit `Scope`.
 * Test clients only support TCP addresses, and rewrite `0.0.0.0` to
 * `127.0.0.1` for local requests.
 *
 * @since 4.0.0
 */
export * as HttpServer from "./HttpServer.ts"

/**
 * Error types and response conversion helpers used by the HTTP server runtime.
 *
 * This module models the failure cases that can happen around a server request:
 * malformed or unreadable requests, unmatched routes, unexpected handler
 * failures, response construction or delivery failures, and lower-level server
 * implementation failures. These errors keep the relevant request, and for
 * response failures the response that was being produced, so applications can
 * report, inspect, or translate failures without losing HTTP context.
 *
 * Most users encounter these errors when decoding request bodies, implementing
 * fallback routes, adding error reporting, or customizing how handler failures
 * become responses. Request parse errors become `400` responses, missing routes
 * become `404` responses and are ignored by the error reporter, and internal or
 * response errors become `500` responses. A `ResponseError` records the response
 * involved in the failure, but its default conversion intentionally sends an
 * empty `500` instead of reusing a response that may already be invalid or
 * partially failed. Handler causes can also contain respondable failures,
 * response defects, or interrupts; the conversion helpers preserve those
 * distinctions, including `499` for client aborts and `503` for server aborts.
 *
 * @since 4.0.0
 */
export * as HttpServerError from "./HttpServerError.ts"

/**
 * Utilities for working with the request visible to HTTP server handlers.
 *
 * This module defines `HttpServerRequest`, the request-scoped context service
 * used by server effects, middleware, schema decoders, multipart parsers,
 * WebSocket upgrades, and conversions between Effect HTTP requests, client
 * requests, and Web `Request` values. Handlers commonly use it to inspect the
 * method, URL, headers, cookies, remote address, and body, or to decode those
 * parts with schemas instead of parsing raw values by hand.
 *
 * Body access is effectful because reading, parsing, schema decoding, or
 * multipart persistence can fail. Streaming request bodies may be single-use
 * depending on the underlying platform, while cached accessors such as text,
 * JSON, URL parameters, array buffers, and persisted multipart data reuse the
 * first read. Multipart persistence also requires `Scope`, `FileSystem`, and
 * `Path` services, and search parameter decoding depends on the
 * `ParsedSearchParams` service being provided by the router or adapter.
 *
 * @since 4.0.0
 */
export * as HttpServerRequest from "./HttpServerRequest.ts"

/**
 * Protocol and conversion helpers for values that can become HTTP server
 * responses.
 *
 * This module lets server-side domain errors, HTTP API errors, and helper
 * modules describe how they should be sent to a client without constructing an
 * `HttpServerResponse` at every call site. Implement `Respondable` on values
 * that should choose their own status, headers, cookies, or body when a route
 * fails or a server helper recovers by sending a response.
 *
 * Conversion is intentionally conservative. Existing `HttpServerResponse`
 * values are returned directly, fallback conversion maps schema errors to `400`
 * and no-such-element errors to `404`, and otherwise uses the caller-provided
 * fallback. Errors raised while running a respondable conversion become defects
 * with `toResponse`, while the fallback helpers catch conversion failures and
 * use the fallback response. Defect conversion only gives special handling to
 * `HttpServerResponse` and `Respondable` values.
 *
 * @since 4.0.0
 */
export * as HttpServerRespondable from "./HttpServerRespondable.ts"

/**
 * Server-side HTTP response values and constructors for Effect HTTP handlers.
 *
 * This module defines `HttpServerResponse`, the immutable response model returned
 * from routers and server effects, together with constructors for empty,
 * redirect, text, HTML, JSON, URL-encoded, raw, form-data, stream, and file
 * bodies. It also includes combinators for adjusting status, headers, cookies,
 * and bodies, plus conversions to and from Web `Response` and client responses.
 *
 * Response constructors choose status defaults for common cases: `204` for
 * `empty`, `302` for `redirect`, and `200` for responses with bodies. Body
 * metadata is mirrored into headers, so content type and content length carried
 * by the body are written to `content-type` and `content-length`, overriding
 * existing values when present. JSON helpers can fail while encoding or
 * serializing unless the unsafe constructor is used.
 *
 * Cookies are tracked separately from the normal header map so they can be
 * encoded as `Set-Cookie` headers when converting to platform responses. Use the
 * effectful cookie helpers when invalid cookie names, values, or options should
 * stay in the Effect error channel.
 *
 * @since 4.0.0
 */
export * as HttpServerResponse from "./HttpServerResponse.ts"

/**
 * Static file serving for Effect HTTP applications.
 *
 * This module builds request handlers and router layers that serve files from a
 * configured root directory. It is intended for public assets such as compiled
 * front-end bundles, images, fonts, downloads, documentation sites, and single
 * page applications that need an `index.html` fallback.
 *
 * Requests are resolved relative to the configured root after decoding and
 * normalizing the URL path. Malformed paths, null bytes, and `..` traversal
 * outside the root are rejected, but the module still serves anything the
 * configured `FileSystem` can reach below that root. Keep secrets out of the
 * served tree, be careful with symlinks or generated files, and remember that
 * dotfiles are not hidden automatically. File responses include content type,
 * optional cache control, byte-range support, and conditional request handling
 * based on the metadata supplied by `HttpPlatform`.
 *
 * @since 4.0.0
 */
export * as HttpStaticServer from "./HttpStaticServer.ts"

/**
 * Utilities for HTTP trace-context propagation.
 *
 * This module converts Effect `Tracer.Span` values to outbound tracing headers
 * and decodes inbound propagation headers into `Tracer.ExternalSpan` parents.
 * It is used by traced HTTP clients to continue the current span across an
 * outbound request, and by server middleware to parent request spans from
 * upstream services. The helpers are also useful for adapters or middleware
 * that need to bridge Effect tracing with W3C Trace Context or B3-compatible
 * systems.
 *
 * Outbound propagation writes both W3C `traceparent` and compact B3 `b3`
 * headers. Inbound decoding prefers W3C `traceparent`, then compact B3, then
 * multi-header B3 (`x-b3-*`). Header names in `Headers.Headers` are expected to
 * be lowercase; use the safe header constructors when accepting raw platform
 * headers. Invalid or unsupported header shapes simply decode to `Option.none`,
 * so callers should treat missing trace context as "start a new trace" rather
 * than as an error.
 *
 * @since 4.0.0
 */
export * as HttpTraceContext from "./HttpTraceContext.ts"

/**
 * Utilities for parsing and working with HTTP `multipart/form-data` request
 * bodies.
 *
 * This module converts multipart byte streams into typed `Part` values, either
 * as decoded text `Field` values or streamed `File` values. It is used by HTTP
 * server request handling for browser form submissions, API endpoints that
 * accept file uploads, and mixed payloads where structured fields accompany one
 * or more uploaded files. Persisted helpers collect fields into records and
 * write files into scoped temporary paths that can be decoded with schemas.
 *
 * Multipart bodies can be large and are often backed by one-shot request
 * streams, so prefer streaming file content unless the file is small enough to
 * collect with `contentEffect`. Persisted file paths are valid only while their
 * scope is open, and client-provided filenames should be treated as metadata
 * rather than trusted filesystem paths. Parser limits for part count, field
 * size, file size, total body size, and field MIME type handling are provided
 * through the module's context references.
 *
 * @since 4.0.0
 */
export * as Multipart from "./Multipart.ts"

/**
 * @since 4.0.0
 */
export * as Multipasta from "./Multipasta.ts"

/**
 * Template literal helpers for rendering HTTP-oriented text with Effect values.
 *
 * This module powers response helpers that accept template tags, such as HTML
 * responses with dynamic fragments, deferred service lookups, or streaming
 * sections. Use `make` when the whole rendered value should be assembled before
 * building the response, and `stream` when parts of the template can be emitted
 * incrementally from effects or streams.
 *
 * Interpolation is intentionally simple: primitive values are converted to
 * strings, arrays are concatenated without separators, and `Option.none`,
 * `null`, and `undefined` render as empty text. The module does not escape HTML,
 * encode bytes, set content types, or compute content lengths, so callers should
 * escape or encode untrusted values and choose the appropriate response
 * constructor for the rendered output.
 *
 * @since 4.0.0
 */
export * as Template from "./Template.ts"

/**
 * Utilities for parsing and immutably updating HTTP URLs.
 *
 * This module works with the platform `URL` type used by HTTP clients and
 * servers, adding safe constructors and pipeable setters for common workflows
 * such as resolving request targets against a base URL, changing credentials,
 * host, path, protocol, query, and hash components, and reading or rewriting
 * query parameters through `UrlParams`.
 *
 * Parsing and serialization follow the platform WHATWG `URL` behavior. Relative
 * inputs need an explicit base, assigned components may be normalized or
 * percent-encoded by `URL`, and query strings should usually be handled through
 * `UrlParams` when preserving repeated keys or applying key/value encoding is
 * important.
 *
 * @since 4.0.0
 */
export * as Url from "./Url.ts"

/**
 * Utilities for representing, transforming, and serializing URL query
 * parameters.
 *
 * This module provides an immutable `UrlParams` collection backed by ordered
 * string key-value pairs. It is used for HTTP client request queries,
 * URL-encoded form bodies, and server-side decoding workflows where query
 * parameters need to be built from records, iterables, or native
 * `URLSearchParams`, then inspected, appended, replaced, removed, converted to a
 * URL, or decoded with schemas.
 *
 * Duplicate keys are preserved by the core representation and by append-style
 * operations; use `getAll` when all values matter, and note that `set` and
 * `setAll` replace existing values for matching keys. Serialization through
 * `toString` and `makeUrl` delegates to the platform `URLSearchParams` / `URL`
 * implementations, so provide decoded strings rather than pre-encoded query
 * fragments. Record-based and schema-based conversions intentionally collapse
 * repeated keys into string arrays and do not preserve the full global pair
 * ordering; `schemaJsonField` reads the first matching value for the selected
 * field.
 *
 * @since 4.0.0
 */
export * as UrlParams from "./UrlParams.ts"
