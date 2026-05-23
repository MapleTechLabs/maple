/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Browser platform implementation of the Crypto service.
 *
 * @since 1.0.0
 */
export * as BrowserCrypto from "./BrowserCrypto.ts"

/**
 * Browser implementations of the Effect `HttpClient`.
 *
 * This module exposes HTTP client layers for code that runs in a browser. It
 * re-exports the fetch-based client for the common case, where requests should
 * use the platform `fetch` implementation and optional `RequestInit` defaults,
 * and it provides an `XMLHttpRequest`-backed layer for integrations that need
 * XHR semantics such as response type control or environments where XHR is the
 * required transport.
 *
 * Use these layers for single-page applications, browser tests, generated
 * `HttpApiClient`s, and other client-side Effect programs that need HTTP
 * requests to participate in interruption, typed transport / decode errors, and
 * Effect's response body readers.
 *
 * Browser networking rules still apply. Cross-origin requests are subject to
 * CORS preflights and server allowlists, especially when using custom headers,
 * non-simple methods, or non-simple content types. Only CORS-exposed response
 * headers are readable, and cookies / authentication are controlled by the
 * browser and the configured fetch `RequestInit.credentials` policy. The XHR
 * layer uses the browser's `XMLHttpRequest` defaults for credentials.
 *
 * Body handling differs between the transports. Fetch delegates body framing to
 * the Web Fetch implementation. The XHR client sends empty, raw, `Uint8Array`,
 * and `FormData` bodies directly, buffers `Stream` request bodies before
 * sending, defaults responses to text, and can be switched to `ArrayBuffer`
 * responses with `withXHRArrayBuffer`. When sending `FormData`, avoid setting
 * an incompatible `Content-Type` header so the browser can generate the
 * multipart boundary.
 *
 * @since 4.0.0
 */
export * as BrowserHttpClient from "./BrowserHttpClient.ts"

/**
 * Browser-backed `KeyValueStore` layers for Effect programs.
 *
 * This module provides `KeyValueStore` implementations backed by the browser's
 * synchronous Web Storage APIs: `localStorage` for origin-scoped data that
 * persists across page reloads and browser sessions, and `sessionStorage` for
 * page-session data that is cleared when that tab or window's page session
 * ends. They are useful for small client-side values such as user preferences,
 * feature flags, lightweight caches, persisted drafts, or session-only workflow
 * state.
 *
 * Web Storage is only available in browser environments and is scoped by origin.
 * Browsers may deny access in private modes or restricted contexts, and writes
 * can fail when storage quotas are exceeded. The API stores strings and runs
 * synchronously on the main thread, so prefer it for small payloads and avoid
 * treating it as a database or a secure place for sensitive data.
 *
 * @since 4.0.0
 */
export * as BrowserKeyValueStore from "./BrowserKeyValueStore.ts"

/**
 * Browser-backed persistence layers for Effect's persistence service.
 *
 * This module provides IndexedDB implementations of the Effect persistence services for applications that need a
 * durable client-side cache, such as remembered query results, offline-capable workflows, or values that should survive
 * page reloads. Entries are stored by persistence store id and key in a shared IndexedDB object store, with optional
 * expiration timestamps for TTL-based invalidation.
 *
 * Because this storage depends on browser IndexedDB, operations can fail when storage is unavailable, quota is exceeded,
 * data is cleared by the user or browser, or the payload cannot be structured-cloned by IndexedDB. Expired entries are
 * removed lazily when they are read, so this module is best suited for application-managed cached objects rather than
 * security-sensitive or authoritative data.
 *
 * @since 4.0.0
 */
export * as BrowserPersistence from "./BrowserPersistence.ts"

/**
 * Browser entry-point helpers for running Effect programs.
 *
 * This module exposes `runMain`, a browser-oriented main runner for launching
 * an Effect as the root program of a page, single-page application, demo, or
 * browser test harness. It delegates execution to the core Effect runtime while
 * adding the browser lifecycle hook needed to interrupt the main fiber when the
 * page receives `beforeunload`.
 *
 * `BrowserRuntime` does not provide application services by itself. Provide
 * any required layers, such as browser HTTP, storage, worker, geolocation, or
 * permission services, before passing the effect to `runMain`. Keep long-lived
 * browser resources scoped so interruption can run their finalizers while the
 * page is still active.
 *
 * Browser unload is more constrained than a process signal. Finalizers that
 * need the network, timers, prompts, or long asynchronous work may not complete
 * once navigation or tab close has started, and browsers do not expose a
 * process exit status. Use `runMain` to connect the page lifecycle to Effect
 * interruption, and use browser-specific persistence or delivery APIs for work
 * that must survive page teardown.
 *
 * @since 4.0.0
 */
export * as BrowserRuntime from "./BrowserRuntime.ts"

/**
 * Browser WebSocket layers for Effect sockets.
 *
 * This module provides the browser entry point for `Socket.Socket` values
 * backed by the platform `WebSocket` implementation. Use `layerWebSocket` when
 * client-side Effect programs, browser tests, RPC transports, or realtime UI
 * features need a bidirectional socket connected to a WebSocket URL, and use
 * `layerWebSocketConstructor` when lower-level socket APIs need access to the
 * browser constructor service.
 *
 * Browser WebSocket rules still apply. Connections are created through
 * `globalThis.WebSocket`, so URL schemes, subprotocol negotiation, mixed-content
 * blocking, cookies, authentication, CORS-like origin checks, and extension
 * negotiation are controlled by the browser and server rather than by Effect.
 * Close events are translated into socket errors unless the provided
 * `closeCodeIsError` predicate classifies the close code as clean, which is
 * useful for protocols that use application-specific close codes.
 *
 * Messages are delivered as strings or binary `Uint8Array` values; browser
 * `Blob` messages are read into bytes before they reach the socket handler.
 * Outgoing data should already be serialized to a string or bytes, and protocol
 * frames that represent an intentional close should be sent as `CloseEvent`
 * values so the underlying `WebSocket.close` code and reason are preserved.
 *
 * @since 4.0.0
 */
export * as BrowserSocket from "./BrowserSocket.ts"

/**
 * Browser `Stream` constructors for DOM event targets.
 *
 * This module provides typed helpers for turning `window.addEventListener` and
 * `document.addEventListener` callbacks into Effect `Stream`s. They are useful
 * for UI and runtime signals such as resize, visibility, keyboard, pointer,
 * focus, online / offline, and other browser events that should be composed
 * with Effect stream operators and finalized with the consuming fiber.
 *
 * Browser events are push-based `EventTarget` notifications, so they do not
 * apply Web Streams backpressure to the browser event source. Events are
 * buffered until downstream pulls them; the default buffer is unbounded, so
 * high-frequency sources like scroll, pointermove, or mousemove should usually
 * set `bufferSize` and use stream operators that sample, debounce, throttle, or
 * drop work as appropriate.
 *
 * These helpers are for DOM events, not for adapting `ReadableStream` request
 * or response bodies. Fetch bodies follow the Web Streams body rules, including
 * single-consumer locking and disturbed bodies after reads, and should be
 * handled with body-specific HTTP or Web Streams APIs instead. When using the
 * browser `once` option, pair the stream with `Stream.take(1)` if a finite
 * stream is required.
 *
 * @since 4.0.0
 */
export * as BrowserStream from "./BrowserStream.ts"

/**
 * Parent-side browser support for Effect workers.
 *
 * This module provides the `WorkerPlatform` used by browser applications that
 * spawn or connect to `Worker`, `SharedWorker`, and `MessagePort` endpoints
 * through Effect's worker protocol. Pair it with `BrowserWorkerRunner` in the
 * worker entrypoint when building worker-backed RPC clients, moving CPU-bound
 * work off the main thread, isolating browser-only services, or adapting an
 * existing `MessageChannel` in tests and custom transports.
 *
 * Dedicated workers communicate through the worker object itself, while shared
 * workers communicate through `worker.port`; raw `MessagePort` values are also
 * accepted and are started when supported. Messages are posted with the browser
 * structured-clone algorithm, so payloads must be cloneable by the target
 * runtime. Transfer lists can avoid copying values such as `ArrayBuffer` or
 * `MessagePort`, but transferring moves ownership away from the sender and
 * invalid or mismatched transferables can fail the send. Scope finalization
 * sends the worker close signal over the port; the application that created a
 * dedicated `Worker` remains responsible for any broader lifecycle such as
 * terminating it.
 *
 * @since 4.0.0
 */
export * as BrowserWorker from "./BrowserWorker.ts"

/**
 * Browser runtime support for Effect worker runners.
 *
 * This module is intended for code that is already executing in a browser
 * worker context, or for tests and adapters that supply a `MessagePort` or
 * `Window` endpoint directly. It provides the `WorkerRunnerPlatform` used by
 * `WorkerRunner` and `RpcServer.layerProtocolWorkerRunner` to receive parent
 * or client requests, run Effect handlers, and send responses through the
 * browser `postMessage` channel.
 *
 * Use it with `BrowserWorker` when a browser application needs to move RPC
 * handlers, CPU-bound computations, or browser-only services into a dedicated
 * worker or shared worker. Dedicated workers communicate through the current
 * `self` endpoint; shared workers accept multiple `onconnect` ports and cache
 * ports that connect before the runner layer starts. Messages still use the
 * browser structured-clone algorithm, so payload schemas, transfer lists,
 * `messageerror` events, and the lifetime of each `MessagePort` must be
 * considered when crossing worker boundaries.
 *
 * @since 4.0.0
 */
export * as BrowserWorkerRunner from "./BrowserWorkerRunner.ts"

/**
 * Browser clipboard service for Effect programs.
 *
 * This module wraps the browser `navigator.clipboard` API in a `Clipboard`
 * service so client-side applications can read, write, and clear clipboard
 * contents as typed Effects. It is useful for common UI workflows such as copy
 * buttons, paste/import actions, sharing generated text, and moving rich
 * clipboard payloads like `Blob`-backed `ClipboardItem`s through an Effect
 * environment.
 *
 * Browser clipboard rules still apply. Clipboard access generally requires a
 * secure context, and browsers may require a user gesture, permission prompt, or
 * active focused document before reads or writes are allowed. Support also
 * varies by operation and payload type: text helpers are the most portable,
 * while `ClipboardItem` and non-text MIME types may be unavailable or restricted
 * in some browsers. Failed browser operations are surfaced as `ClipboardError`.
 *
 * @since 4.0.0
 */
export * as Clipboard from "./Clipboard.ts"

/**
 * Browser geolocation support for Effect programs.
 *
 * This module provides a `Geolocation` service and browser-backed layer for
 * reading device location through `navigator.geolocation`. Use
 * `getCurrentPosition` when an application needs one location fix, such as a
 * nearby-search, check-in, or delivery estimate, and `watchPosition` when it
 * needs a stream of updates for navigation, tracking, or location-aware UI.
 *
 * The implementation is browser-only and relies on the browser permission and
 * policy model for geolocation. Calls may prompt the user, fail when permission
 * is denied, time out, or report that position data is unavailable because of
 * device, browser, privacy, origin, or secure-context restrictions. Watched
 * positions are scoped so the underlying browser watch is cleared when the
 * stream is finalized, and slow consumers should account for the sliding
 * buffer used by `watchPosition`.
 *
 * @since 4.0.0
 */
export * as Geolocation from "./Geolocation.ts"

/**
 * Browser IndexedDB primitives and key schemas for Effect applications.
 *
 * This module is the low-level bridge used by the platform-browser IndexedDB
 * integration. It provides an `IndexedDb` service around the browser
 * `indexedDB` factory and `IDBKeyRange` constructor, a `layerWindow` layer for
 * wiring those primitives from `window`, and schemas for the key shapes accepted
 * by IndexedDB object stores and indexes.
 *
 * Use it when building typed local persistence for browser caches,
 * offline-first state, background queues, drafts, or other client-side data
 * that should be validated before it reaches IndexedDB. Higher-level database,
 * version, table, and query modules build on these primitives for migrations
 * and typed transactions.
 *
 * IndexedDB still follows the browser rules: schema changes happen only during
 * version upgrades, upgrades may be blocked by other open tabs or connections,
 * and reads or writes must run in transactions scoped to the object stores they
 * touch. The `layerWindow` constructor should be used only where browser
 * globals are available, and code that also runs during SSR or in restricted
 * browser contexts should account for `indexedDB` or `IDBKeyRange` being
 * missing.
 *
 * @since 4.0.0
 */
export * as IndexedDb from "./IndexedDb.ts"

/**
 * Builds and opens typed IndexedDB databases from versioned schema migrations.
 *
 * This module turns an `IndexedDbVersion` migration chain into an
 * `IndexedDbDatabase` layer. The layer opens the browser database, runs any
 * pending upgrade migrations, provides a query builder for the current schema,
 * and exposes a `rebuild` effect that deletes and reopens the database. It is
 * the database-level companion to the table, version, and query builder
 * modules.
 *
 * Use it for browser-local persistence such as offline-first application
 * state, cached server data, background queues, drafts, and other client-side
 * stores that need typed reads and writes backed by IndexedDB transactions.
 *
 * IndexedDB schema changes can only happen inside upgrade transactions, so
 * every call to `make` or `.add` represents the next browser database version
 * and only migrations after the existing browser version are run. Table and
 * index definitions type the migration and query APIs, but object stores and
 * indexes still need to be created or removed explicitly with the migration
 * transaction helpers. Include the complete target table set in each version,
 * create indexes before querying them, and treat key path or auto-increment
 * changes as store migrations that copy data into a replacement object store.
 * Upgrades can be blocked by other open connections, and all migration reads,
 * writes, store changes, and index changes share the single upgrade
 * transaction supplied by the browser.
 *
 * @since 4.0.0
 */
export * as IndexedDbDatabase from "./IndexedDbDatabase.ts"

/**
 * Builds effectful, schema-aware queries for typed browser IndexedDB versions.
 *
 * An `IndexedDbQueryBuilder` is created from an open database and a version's
 * table descriptors, then exposes `from(tableName)` as the entry point for
 * table operations. The resulting query objects can select, count, delete,
 * insert, upsert, clear tables, stream paged reads, react to invalidations, and
 * run multiple effects in a shared `IDBTransaction` with `withTransaction`.
 *
 * Use this module for local browser persistence such as caches, offline-first
 * state, background queues, drafts, and other client-side data where writes
 * should be encoded through `Schema` and reads should be decoded before they
 * reach application code.
 *
 * Index and range helpers are thinly typed wrappers around IndexedDB object
 * stores, indexes, `IDBKeyRange`, and cursors. Index names must be declared on
 * the table and created during migrations; without an index, queries use the
 * object store key path. Range values are encoded IndexedDB key values, and
 * compound key paths must follow the declared key order. Filters, offsets,
 * reverse reads, out-of-line keys, and limited deletes require cursor-based
 * scans, while simpler selects can use `getAll`.
 *
 * Table schema details affect runtime behavior: auto-increment writes may omit
 * the generated numeric key, stores without a key path require an out-of-line
 * `key` for writes and add that `key` back to selected rows, and schema
 * mismatches surface as `EncodeError` or `DecodeError` query failures.
 *
 * @since 4.0.0
 */
export * as IndexedDbQueryBuilder from "./IndexedDbQueryBuilder.ts"

/**
 * Defines typed table descriptors for the browser IndexedDB integration.
 *
 * An `IndexedDbTable` records the object store name, row schema, primary key
 * path, indexes, auto-increment behavior, and transaction durability used by
 * database versions, migrations, and typed queries. These descriptors are
 * useful for local caches, offline-first application state, background queues,
 * drafts, and other browser-persisted data that should be validated through
 * `Schema`.
 *
 * Key paths and index paths must reference encoded schema fields whose values
 * are valid IndexedDB keys, and compound paths are represented as readonly
 * arrays. Tables without a key path use an out-of-line `key` that is added to
 * reads and required for writes, so the row schema itself cannot define a
 * `key` field. Auto-increment tables require a numeric key path; when that key
 * is omitted on write, the module uses a derived schema without the generated
 * key. Declaring indexes here types query builder index selection, but the
 * indexes still need to be created during database migrations.
 *
 * @since 4.0.0
 */
export * as IndexedDbTable from "./IndexedDbTable.ts"

/**
 * Typed IndexedDB schema version definitions.
 *
 * This module represents one logical IndexedDB database version as a non-empty set of `IndexedDbTable` definitions.
 * Versions are consumed by `IndexedDbDatabase.make` and `.add` to type query builders and migration transactions, so
 * applications can describe the tables available after initialization or after each schema upgrade.
 *
 * Use an `IndexedDbVersion` when defining the initial stores for a browser database, adding or removing object stores,
 * changing indexes, or moving data between differently shaped table schemas. The version value is a typed description of
 * the target schema; creating and deleting object stores or indexes still happens explicitly inside the corresponding
 * `IndexedDbDatabase` migration callback.
 *
 * IndexedDB versioning is ordered by the migration chain rather than by a number stored here. Each `.add` step becomes
 * the next browser database version, and only migrations after the browser's current version are run. Include every table
 * that should be queryable in each target version, avoid duplicate table names, and remember that key-path or
 * auto-increment changes usually require creating a new object store and copying data during the upgrade transaction.
 *
 * @since 4.0.0
 */
export * as IndexedDbVersion from "./IndexedDbVersion.ts"

/**
 * Browser Permissions API support for Effect programs.
 *
 * This module provides a `Permissions` service and browser-backed layer for
 * querying `navigator.permissions` from Effect code. Use it to check whether a
 * browser capability is currently `granted`, `prompt`, or `denied` before
 * showing UI for flows such as geolocation, notifications, clipboard access,
 * camera, microphone, or persistent storage.
 *
 * Permission queries do not request access by themselves and should not replace
 * the feature API that actually performs the operation. Browser support for
 * permission names and states is uneven, queries may reject for unsupported or
 * invalid descriptors, and some permissions are only meaningful in secure
 * contexts or after user activation. Returned `PermissionStatus` objects can
 * change when the user updates browser settings or responds to prompts; when
 * watching `change` or `onchange`, account for browser differences and clean up
 * listeners when the surrounding Effect scope ends.
 *
 * @since 4.0.0
 */
export * as Permissions from "./Permissions.ts"
