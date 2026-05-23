/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * The `HttpApi` module defines the top-level contract for an Effect HTTP API.
 * An `HttpApi` names an API and collects one or more `HttpApiGroup`s, whose
 * endpoints describe the request inputs, response schemas, middleware, and
 * annotations that later drive server builders, clients, and OpenAPI
 * generation.
 *
 * Use this module when you want to compose a domain API from endpoint groups,
 * combine APIs from multiple modules, apply a shared path prefix or middleware,
 * attach annotations, or reflect over the final route shape. Implementations are
 * provided separately with `HttpApiBuilder.group`, and the completed API is
 * registered with `HttpApiBuilder.layer`.
 *
 * A few composition details are worth keeping in mind: group identifiers are
 * used as keys, so adding another group with the same identifier replaces the
 * previous one; `prefix` and `middleware` are applied to the groups and
 * endpoints already present when they are called; and `addHttpApi` merges the
 * added API's annotations into its groups. During reflection, success and error
 * schemas are grouped by the HTTP status recorded on their `HttpApiSchema`
 * annotations, endpoints without an explicit success schema default to
 * `NoContent`, and middleware error schemas are included with endpoint errors.
 * Extra schemas supplied through `AdditionalSchemas` must have an `identifier`
 * annotation so they can be emitted as OpenAPI components.
 *
 * @since 4.0.0
 */
export * as HttpApi from "./HttpApi.ts"

/**
 * The `HttpApiBuilder` module connects declarative `HttpApi` definitions to
 * runnable HTTP server routes.
 *
 * Use this module when you have described an API with `HttpApi`,
 * `HttpApiGroup`, and `HttpApiEndpoint` values and need to provide the
 * server-side implementation. `group` creates a layer for implementing every
 * endpoint in one API group, `layer` registers the implemented groups with an
 * `HttpRouter` and can expose the generated OpenAPI specification, and
 * `endpoint` builds the effect for a single endpoint when custom composition is
 * needed.
 *
 * The builder performs the runtime work implied by endpoint metadata: it decodes
 * path parameters, headers, query parameters, and request payloads with
 * `Schema`, applies endpoint middleware and security middleware, invokes the
 * registered handler, and encodes successful or declared error results into
 * `HttpServerResponse` values. Handlers can return an `HttpServerResponse`
 * directly to bypass success encoding, and `handleRaw` can be used when payload
 * decoding should be handled manually.
 *
 * A few implementation details are worth keeping in mind. Every group in the
 * API must be provided with `HttpApiBuilder.group` before `layer` is evaluated,
 * otherwise registration fails with a defect that names the missing group and
 * the available group services. Payload decoding is selected by request media type;
 * unsupported content types produce a `415` response before the handler runs.
 * Schema failures are wrapped as `HttpApiSchemaError`, while ordinary handler
 * failures are encoded with the endpoint's declared error schemas.
 *
 * @since 4.0.0
 */
export * as HttpApiBuilder from "./HttpApiBuilder.ts"

/**
 * Builds type-safe clients and URL builders from `HttpApi` declarations.
 *
 * This module turns the groups and endpoints described by an `HttpApi` into
 * callable client methods backed by an `HttpClient`. Applications commonly use
 * `make` or `makeWith` to call a remote API with the same schema-driven contract
 * as the server, while `group`, `endpoint`, and `urlBuilder` are useful when only
 * part of an API or only the encoded URL is needed.
 *
 * Client calls encode path parameters, query values, headers, and payloads from
 * endpoint schemas before executing the request, then decode successful responses
 * according to the endpoint success schemas. The selected `responseMode` can
 * return the decoded value, the raw `HttpClientResponse`, or both; the raw
 * response mode skips success and error decoding for custom response handling.
 *
 * Pay attention to the endpoint schemas when shaping requests: payloads for HTTP
 * methods without request bodies are encoded into URL parameters, multipart
 * payloads must be supplied as `FormData`, and response decoding can fail with
 * `SchemaError`. Declared error responses are decoded into the endpoint error
 * type, unknown statuses fail as `HttpClientError.DecodeError`, and failures while
 * decoding a declared error response include the original status-code failure.
 *
 * @since 4.0.0
 */
export * as HttpApiClient from "./HttpApiClient.ts"

/**
 * The `HttpApiEndpoint` module defines the per-route contracts used inside an
 * `HttpApiGroup`.
 *
 * An endpoint couples a stable name with an HTTP method and `HttpRouter` path,
 * plus schemas for path parameters, query parameters, headers, request payloads,
 * success responses, and declared errors. Server builders, generated clients,
 * and OpenAPI generation all read this metadata to decode requests, encode
 * responses, type handler inputs, and derive client call signatures.
 *
 * Use this module to declare individual operations such as `get`, `post`, `put`,
 * `patch`, `delete`, `head`, and `options`; attach endpoint-specific middleware
 * or annotations; and model alternatives for payloads, successes, and errors
 * with arrays of schemas.
 *
 * A few declaration details are worth keeping in mind. Paths use
 * `HttpRouter.PathInput`, so route parameters come from the router and are
 * decoded with the optional `params` schema. When codecs are enabled, params,
 * query, and headers are transformed through string-tree codecs; body methods
 * use JSON payload codecs by default, while no-body methods encode payloads as
 * query-style values. `HttpApiSchema` annotations can change payload or response
 * encodings and status codes, multipart payloads cannot be combined under the
 * same content type, and endpoint errors are merged with middleware errors for
 * server encoding and client decoding.
 *
 * @since 4.0.0
 */
export * as HttpApiEndpoint from "./HttpApiEndpoint.ts"

/**
 * The `HttpApiError` module defines the built-in error types used by Effect's
 * unstable HTTP API layer for common failure responses.
 *
 * Each exported status error is a `Schema.ErrorClass` with an `httpApiStatus`
 * annotation, so it can be declared as an endpoint or middleware error schema
 * and then used by reflection, OpenAPI generation, clients, and server response
 * encoding. The classes also implement `HttpServerRespondable`, which means
 * using one directly as a server response produces an empty response with the
 * matching HTTP status.
 *
 * Use the `*NoContent` variants when the wire response intentionally has no
 * body but clients should still decode that status into a typed error value.
 * For custom error schemas, make sure to add the intended
 * `HttpApiSchema.status` annotation; error schemas without one are treated as
 * `500 Internal Server Error` by the HTTP API machinery. Schema failures raised
 * while decoding params, headers, query, body, or payload values are represented
 * separately by `HttpApiSchemaError`, which responds as `400 Bad Request` unless
 * transformed by middleware.
 *
 * @since 4.0.0
 */
export * as HttpApiError from "./HttpApiError.ts"

/**
 * The `HttpApiGroup` module defines named collections of `HttpApiEndpoint`s
 * within an `HttpApi`.
 *
 * Groups are the main way to organize endpoints by a domain boundary, resource,
 * or feature area before those endpoints are added to an API and implemented
 * with `HttpApiBuilder.group`. A group carries its identifier, endpoint set,
 * annotations, and `topLevel` flag, which are later used by builders, clients,
 * URL builders, and OpenAPI generation. Non-top-level groups expose nested
 * client methods under the group name, while top-level groups expose their
 * endpoint methods directly.
 *
 * Composition is order-sensitive. Adding an endpoint with the same name as an
 * existing endpoint replaces it, and `prefix`, `middleware`,
 * `annotateEndpoints`, and `annotateEndpointsMerge` only affect endpoints that
 * are already present when those APIs are called. Group annotations apply to the
 * group itself; use the endpoint annotation helpers when metadata should be
 * attached to each endpoint.
 *
 * The type helpers in this module reflect the endpoint union for a group and
 * aggregate the services required by endpoint schemas, middleware, and declared
 * errors. Error schemas are still declared on endpoints, while middleware can
 * contribute additional error schemas and client/server service requirements
 * through the endpoint middleware set.
 *
 * @since 4.0.0
 */
export * as HttpApiGroup from "./HttpApiGroup.ts"

/**
 * The `HttpApiMiddleware` module defines middleware services that can wrap
 * `HttpApi` endpoint execution on the server and request execution in generated
 * clients.
 *
 * Use this module for cross-cutting HTTP API behavior such as authentication and
 * authorization, request logging or tracing, rate limiting, adding request-scoped
 * services to the endpoint context, normalizing schema errors, or installing
 * client-side request middleware for APIs that require the same concern on both
 * sides. Middleware services carry type-level metadata describing the services
 * they require and provide, the error schemas they may fail with, whether they
 * implement security schemes, and whether generated clients must provide a
 * matching client middleware.
 *
 * Security middleware is declared with non-empty `security` schemes and receives
 * decoded credentials from `HttpApiSecurity`; ordinary middleware receives only
 * endpoint and group metadata. Error declarations must be `Schema` values (or an
 * array of them) because middleware failures are added to the endpoint error
 * surface and must be encodable by the HTTP API builder. If a middleware turns
 * `HttpApiSchemaError` failures into API errors, use
 * `layerSchemaErrorTransform` and make sure the transformed error is covered by
 * the middleware's declared schema. Client middleware installed with
 * `layerClient` is made available through the `ForClient` marker and captures
 * its surrounding context, so client requirements should be declared explicitly
 * when `requiredForClient` is enabled.
 *
 * @since 4.0.0
 */
export * as HttpApiMiddleware from "./HttpApiMiddleware.ts"

/**
 * The `HttpApiScalar` module mounts an interactive Scalar API reference for a
 * declarative `HttpApi`.
 *
 * Use this module when you want a browser-friendly documentation page for an
 * `HttpApi` without maintaining a separate OpenAPI document. The `layer`
 * helper registers a `GET` route on an `HttpRouter`, generates the OpenAPI
 * specification with `OpenApi.fromApi`, embeds it into the HTML page, and loads
 * the bundled Scalar browser script. `layerCdn` provides the same UI while
 * loading Scalar from jsDelivr, optionally pinned with `version`.
 *
 * The mounted path is a documentation UI route, defaulting to `/docs`, rather
 * than a raw JSON specification endpoint. If clients, gateways, or external
 * documentation pipelines need the OpenAPI document directly, expose it
 * separately with `HttpApiBuilder.layer`'s `openapiPath` option. Scalar
 * configuration is forwarded to the page through `ScalarConfig`; values such as
 * `proxyUrl`, theme and layout settings, and `baseServerURL` matter when
 * enabling "Test Request", styling the docs, or rendering relative server URLs
 * outside the browser origin.
 *
 * @since 4.0.0
 */
export * as HttpApiScalar from "./HttpApiScalar.ts"

/**
 * Helpers for attaching HTTP API metadata to Effect Schema values.
 *
 * This module is the schema-side bridge used by the unstable HttpApi endpoint
 * builder, generated clients, and OpenAPI support. It does not define routes or
 * perform IO. Instead, helpers such as {@link status}, {@link asJson},
 * {@link asMultipart}, and {@link asNoContent} annotate schemas so downstream
 * HTTP tooling can choose response status codes, content types, body codecs, and
 * no-body handling while the original schema remains usable for validation and
 * transformation.
 *
 * Common use cases:
 * - Mark success or error schemas with explicit HTTP statuses using
 *   {@link status}, {@link NoContent}, {@link Created}, {@link Accepted}, or
 *   {@link Empty}.
 * - Override the default JSON encoding for request payloads or responses with
 *   {@link asFormUrlEncoded}, {@link asText}, {@link asUint8Array}, or
 *   {@link asJson}.
 * - Describe buffered or streaming multipart request payloads with
 *   {@link asMultipart} and {@link asMultipartStream}.
 * - Represent an HTTP response with no body while still decoding a client-side
 *   value through {@link asNoContent}.
 *
 * Status and encoding details:
 * - {@link status} only stores an annotation. The same annotation is interpreted
 *   by the surrounding HttpApi context; unannotated success responses default to
 *   `200`, and unannotated error responses default to `500`.
 * - Missing encodings default to JSON for bodies and responses. Payload schemas
 *   used with methods that have no request body fall back to form-url-encoded
 *   metadata for parameter encoding.
 * - {@link asFormUrlEncoded} expects the schema's encoded side to be a record
 *   of strings. {@link asText} expects `string`, and {@link asUint8Array}
 *   expects `Uint8Array`.
 * - Multipart encodings are payload-only; response multipart is rejected when
 *   response encoding is resolved.
 * - These helpers attach annotations consumed by HttpApi internals. They do not
 *   validate, encode, decode, or send data by themselves.
 *
 * @since 4.0.0
 */
export * as HttpApiSchema from "./HttpApiSchema.ts"

/**
 * The `HttpApiSecurity` module defines the security scheme values used by
 * declarative HTTP APIs.
 *
 * Use these constructors when an API group or endpoint needs authentication
 * middleware for bearer tokens, API keys, or HTTP Basic credentials. The values
 * are intentionally small declarations: `HttpApiMiddleware.Service` attaches
 * them to middleware, `HttpApiBuilder` decodes the matching credential shape from
 * each request, and OpenAPI generation emits the corresponding
 * `components.securitySchemes` and operation security requirements.
 *
 * Common uses include modeling `Authorization: Bearer ...` tokens, Basic
 * username/password credentials, and API keys passed through headers, query
 * parameters, or cookies. Bearer tokens and API-key values are exposed to
 * middleware as `Redacted` values; Basic credentials expose the username with a
 * redacted password. Cookie API keys can also be written to responses with
 * `HttpApiBuilder.securitySetCookie`.
 *
 * A security scheme does not authenticate by itself: middleware must reject empty
 * or invalid credentials. Bearer and Basic schemes read the `Authorization`
 * header, while API-key headers use HTTP header name normalization and API-key
 * query or cookie names are matched exactly. OpenAPI annotations such as
 * descriptions and bearer formats affect generated documentation only; they do
 * not change runtime decoding.
 *
 * @since 4.0.0
 */
export * as HttpApiSecurity from "./HttpApiSecurity.ts"

/**
 * Serves Swagger UI for an `HttpApi` by rendering the OpenAPI document generated
 * from the API directly into an HTML page.
 *
 * Use this module when you want a lightweight documentation route for a running
 * `HttpApi`, typically in development, staging, internal consoles, or public API
 * reference pages where Swagger UI's exploration and request-building tools are
 * preferred. The exported `layer` adds a `GET` route to an `HttpRouter`,
 * defaults the mount path to `/docs`, and leaves API implementation and server
 * wiring to `HttpApiBuilder` and the surrounding router layers.
 *
 * The page is self-contained: `OpenApi.fromApi` derives the specification from
 * the API's groups, endpoints, schemas, and OpenAPI annotations, then the JSON
 * is embedded into the HTML served to the browser. No separate `/openapi.json`
 * endpoint is installed by this module, so clients or documentation pipelines
 * that need the raw spec should use `OpenApi.fromApi` directly or expose a JSON
 * route elsewhere. If the docs are public, mount the layer behind the same
 * routing, security, or environment controls you want for the UI; generated
 * server URLs and operation metadata come from the API's OpenAPI annotations.
 *
 * @since 4.0.0
 */
export * as HttpApiSwagger from "./HttpApiSwagger.ts"

/**
 * The `HttpApiTest` module provides helpers for testing `HttpApi`
 * implementations through the generated client interface without starting an
 * HTTP server.
 *
 * Use this module when a test should exercise one or more implemented API
 * groups with the same request encoding, routing, response encoding, and client
 * decoding used by the production `HttpApiBuilder` and `HttpApiClient`
 * pipeline. This is useful for focused handler tests, schema round-trip checks,
 * middleware behavior, and tests that want to call an API through its typed
 * client while keeping all traffic in memory.
 *
 * The selected groups must be provided in the test environment, usually by
 * supplying the corresponding `HttpApiBuilder.group` layers. Groups that are not
 * selected are still present on the returned client shape, but their handlers
 * are placeholders that die if called, which helps catch accidental calls outside
 * the test scope. The generated client is still a real `HttpApiClient`, so
 * endpoint middleware, client middleware, platform services, and the optional
 * `baseUrl` used for URL construction follow the same rules as normal clients;
 * only the HTTP transport is replaced with an in-memory router dispatch.
 *
 * @since 4.0.0
 */
export * as HttpApiTest from "./HttpApiTest.ts"

/**
 * The `OpenApi` module converts declarative `HttpApi` definitions into
 * OpenAPI 3.1 specifications and provides annotations for shaping the
 * generated document.
 *
 * Use this module when you need to publish an `HttpApi` contract to tooling
 * such as Swagger UI, Scalar, client generators, API gateways, or documentation
 * pipelines. `fromApi` reflects the API's groups and endpoints into tags,
 * paths, operations, parameters, request bodies, responses, security schemes,
 * and component schemas while preserving Effect Schema metadata where OpenAPI
 * can represent it.
 *
 * The generated specification is driven by annotations on APIs, groups,
 * endpoints, security definitions, and schemas. `Title`, `Description`,
 * `Summary`, `Version`, `Servers`, `License`, `ExternalDocs`, `Identifier`,
 * `Deprecated`, and `Format` feed the corresponding OpenAPI fields; `Exclude`
 * omits a group or endpoint; `Override` shallowly merges custom fields; and
 * `Transform` can rewrite the generated API, tag, or operation object. Schema
 * identifiers are important for stable component names, additional schemas must
 * have identifiers, and invalid OpenAPI component keys are rejected during
 * generation.
 *
 * A few generation details are worth keeping in mind: `HttpApiSchema`
 * encodings choose media types and special representations for JSON,
 * form-url-encoded, text, binary, and multipart payloads; no-content schemas
 * emit responses without bodies; request and response unions are grouped by
 * status code and content type; path parameters are rendered from `:id` route
 * segments as `{id}`; and schemas are converted through the OpenAPI 3.1 JSON
 * Schema representation before being patched into the final document.
 *
 * @since 4.0.0
 */
export * as OpenApi from "./OpenApi.ts"
