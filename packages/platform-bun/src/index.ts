/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Node.js implementation of `ChildProcessSpawner`.
 *
 * @since 4.0.0
 */
export * as BunChildProcessSpawner from "./BunChildProcessSpawner.ts"

/**
 * The `BunClusterHttp` module provides the Bun HTTP and WebSocket transports
 * for Effect Cluster runners. It wires `HttpRunner` to the Bun HTTP server,
 * supplies Fetch and Bun WebSocket client protocols, and builds a complete
 * sharding layer with serialization, runner health, runner storage, and message
 * storage.
 *
 * **Common tasks**
 *
 * - Run a Bun process as a cluster runner over HTTP or WebSocket with
 *   {@link layer}
 * - Connect a client-only process to an existing HTTP cluster without starting
 *   a runner server
 * - Use SQL-backed storage for durable multi-process clusters, `local` storage
 *   for short-lived development, or `byo` storage when the deployment owns the
 *   persistence boundary
 * - Check runner health with protocol pings or Kubernetes pod readiness through
 *   {@link layerK8sHttpClient}
 *
 * **Gotchas**
 *
 * - `runnerAddress` is the host and port advertised to other runners; set
 *   `runnerListenAddress` when the local bind address differs from the
 *   externally reachable address
 * - The HTTP and WebSocket transports serve runner RPCs at the default
 *   `HttpRunner` route, so proxies and load balancers must preserve the path
 *   and allow WebSocket upgrades when `transport` is `"websocket"`
 * - `clientOnly` does not start an HTTP server or receive shard assignments
 * - SQL storage is the default; `local` storage is in-memory/noop and `byo`
 *   requires the surrounding application to provide both runner and message
 *   storage services
 * - Ping health checks use the selected transport and serialization, so route,
 *   port, proxy, or codec mismatches can make a runner appear unhealthy
 *
 * @since 4.0.0
 */
export * as BunClusterHttp from "./BunClusterHttp.ts"

/**
 * The `BunClusterSocket` module provides the Bun socket transport for Effect
 * Cluster runners. It wires `SocketRunner` to Bun-compatible TCP sockets,
 * supplies RPC client and server protocol layers, and builds a complete
 * sharding layer with serialization, runner health, runner storage, and message
 * storage.
 *
 * **Common tasks**
 *
 * - Run a Bun process as a cluster runner over raw TCP sockets with
 *   {@link layer}
 * - Connect a client-only process to an existing socket cluster without
 *   starting a runner server
 * - Use SQL-backed storage for durable multi-process clusters, `local` storage
 *   for short-lived development, or `byo` storage when the deployment owns the
 *   persistence boundary
 * - Check runner health with socket pings or Kubernetes pod readiness through
 *   {@link layerK8sHttpClient}
 *
 * **Gotchas**
 *
 * - `runnerAddress` is the host and port advertised to other runners; set
 *   `runnerListenAddress` when the local bind address differs from the
 *   externally reachable address
 * - The socket transport is point-to-point RPC, not cluster gossip: runner
 *   membership, shard ownership, and persisted delivery are coordinated through
 *   `RunnerStorage`, `MessageStorage`, and `RunnerHealth`
 * - `clientOnly` does not start a socket server or receive shard assignments
 * - SQL storage is the default; `local` storage is in-memory/noop and `byo`
 *   requires the surrounding application to provide both runner and message
 *   storage services
 * - Ping health checks use the same socket protocol, so unreachable ports,
 *   firewalls, or serialization mismatches can make a runner appear unhealthy
 * - Kubernetes health checks use Bun's Fetch-backed HTTP client and the service
 *   account CA certificate when it is available
 *
 * @since 4.0.0
 */
export * as BunClusterSocket from "./BunClusterSocket.ts"

/**
 * Bun platform Crypto service layer.
 *
 * @since 1.0.0
 */
export * as BunCrypto from "./BunCrypto.ts"

/**
 * Bun layer for Effect's `FileSystem` service.
 *
 * Use this module at the edge of Bun applications, CLIs, scripts, and tests
 * that need real local filesystem access through `effect/FileSystem`: reading
 * and writing files, creating directories and temporary files, inspecting
 * metadata, managing links, or watching paths for changes. It exposes only the
 * Bun `FileSystem` layer; the operations themselves are accessed from the
 * `FileSystem` service once the layer is provided, or from `BunServices.layer`
 * when the program also needs the standard Bun path, stdio, terminal, and child
 * process services.
 *
 * Bun supports Node-compatible filesystem APIs, so this layer reuses the shared
 * Node filesystem implementation. Paths therefore follow the current process and
 * host platform rules: relative paths are resolved from the current working
 * directory, separators and drive/UNC behavior are platform-dependent, and
 * request URLs should be decoded and validated before being mapped to local
 * paths. The service works with bytes, scoped file handles, and Effect
 * streams/sinks; use `FileSystem.stream` for large files instead of
 * `readFile`, and remember that stream offsets and lengths are byte positions.
 * Bun `File` and `Blob` values are not filesystem handles here; path-based HTTP
 * file responses are handled by the Bun HTTP platform adapter with `Bun.file`.
 *
 * @since 4.0.0
 */
export * as BunFileSystem from "./BunFileSystem.ts"

/**
 * @since 4.0.0
 */
export * as BunHttpClient from "./BunHttpClient.ts"

/**
 * Bun implementation of the Effect HTTP platform service.
 *
 * This module connects the portable `HttpPlatform` file response helpers to
 * Bun's Web-compatible runtime. `BunHttpServer` provides this layer when
 * applications serve local files, public assets, downloads, byte ranges, or
 * Web `File` values from Effect `HttpServerResponse` constructors.
 *
 * Path-based responses are backed by `Bun.file`, and Web `File` responses are
 * returned directly as raw response bodies. The shared `HttpPlatform` service
 * still computes file metadata such as ETags and last-modified headers, while
 * this adapter lets Bun's `Response` implementation handle the platform body.
 *
 * Because the Bun server adapter sits on top of Web `Request` and `Response`,
 * request bodies follow the usual single-consumption rules: choose the
 * streamed, text, URL-encoded, or multipart view that matches the route. For
 * `FormData` responses, let the `Response` constructor create the multipart
 * content type and boundary unless you intentionally override it. File
 * responses take filesystem paths, not request URLs; Bun request URLs are
 * absolute at the runtime edge, and route paths are normalized by
 * `BunHttpServer`, so decode and validate URL pathnames before mapping them to
 * files.
 *
 * @since 4.0.0
 */
export * as BunHttpPlatform from "./BunHttpPlatform.ts"

/**
 * Bun implementation of the Effect `HttpServer`.
 *
 * This module builds an Effect HTTP server from `Bun.serve`, translating Bun's
 * Web `Request` objects into `HttpServerRequest` values and Effect
 * `HttpServerResponse` values back into Web `Response` objects. It is the Bun
 * runtime entry point for serving `HttpApp`s, streaming responses, file
 * responses through `BunHttpPlatform`, multipart requests, and websocket
 * endpoints through `HttpServerRequest.upgrade`.
 *
 * Common use cases include using {@link layer} or {@link layerConfig} to serve
 * an application from Bun configuration, {@link layerServer} when only the
 * `HttpServer` service is needed, and {@link layerTest} for tests that need an
 * ephemeral Bun listener and fetch-compatible client.
 *
 * Bun supplies absolute request URLs and Web-standard request bodies. This
 * adapter stores the normalized path-and-query URL on `HttpServerRequest.url`,
 * while the underlying `Request` still follows Web body rules: pick the
 * streamed, text, JSON, URL-encoded, or multipart view that matches the route
 * instead of consuming the same body in incompatible ways. Because `Bun.serve`
 * has a single active `fetch` handler, each `serve` call reloads that handler
 * and restores the previous one when the serve scope finalizes.
 *
 * WebSocket upgrades must happen from the Bun request handler. The
 * `HttpServerRequest.upgrade` effect calls `server.upgrade`, fails when Bun says
 * the request is not upgradeable, buffers messages that arrive before the
 * Effect socket handler is installed, and maps non-normal close codes into
 * `Socket` errors. The server is stopped with `server.stop()` when its
 * acquisition scope closes; unless preemptive shutdown is disabled, finalizing
 * a serve scope also starts that stop with the configured graceful shutdown
 * timeout or the default timeout.
 *
 * @since 4.0.0
 */
export * as BunHttpServer from "./BunHttpServer.ts"

/**
 * Accessors for the Bun `Request` object backing a platform Bun
 * `HttpServerRequest`.
 *
 * Use this module at interop boundaries when an Effect HTTP handler needs the
 * original `Bun.BunRequest`, for example to read Bun route parameters, pass the
 * request to Bun-specific APIs, inspect Web `Request` fields that are not
 * exposed by the portable `HttpServerRequest` interface, or coordinate with code
 * that already works directly with Bun's server request type.
 *
 * The returned request is the original Web request supplied by `Bun.serve`. It
 * does not reflect Effect request overrides made by middleware, such as a
 * rewritten URL, adjusted headers, or a substituted remote address. Its body is
 * the same one-shot Web `ReadableStream` used by the Effect body helpers, so
 * calling `text`, `json`, `formData`, `arrayBuffer`, or reading `body` directly
 * can disturb the request and conflict with Effect body, multipart, or stream
 * helpers unless ownership of the body is clear.
 *
 * Bun stores client IP information on the server rather than on the request
 * object. Prefer `HttpServerRequest.remoteAddress` when you need the address
 * seen by Effect or middleware; the raw request returned here will not expose
 * middleware-provided remote address overrides.
 *
 * @since 4.0.0
 */
export * as BunHttpServerRequest from "./BunHttpServerRequest.ts"

/**
 * Bun-specific helpers for parsing HTTP `multipart/form-data` request bodies.
 *
 * This module adapts a Bun `Request` body and headers into the shared
 * `Multipart` model. Use `stream` from Bun HTTP handlers when form fields and
 * uploaded files should be consumed incrementally, for example validating text
 * fields while piping large file parts to storage. Use `persisted` when the
 * whole form should be collected into a record and file parts should be written
 * to scoped temporary files through the current `FileSystem`, `Path`, and
 * `Scope` services.
 *
 * Bun requests expose one-shot web streams, so choose one body reader and do
 * not call `formData`, `text`, `json`, or `arrayBuffer` before using this
 * module. Incoming `FormData` uploads must include a `multipart/form-data`
 * content type with the boundary generated by the client; when constructing
 * `FormData` requests, let the runtime set that header. Stream file content for
 * large uploads, reserve `contentEffect` for small files, and treat client
 * filenames as metadata rather than trusted filesystem paths. Persisted file
 * paths remain valid only for the surrounding scope.
 *
 * @since 4.0.0
 */
export * as BunMultipart from "./BunMultipart.ts"

/**
 * Bun layers for Effect's `Path` service.
 *
 * Use this module when an Effect program running on Bun needs path
 * manipulation from the `Path` service, such as joining and normalizing local
 * filesystem locations, resolving configuration or static asset paths, handling
 * CLI path arguments, or converting between filesystem paths and `file:` URLs.
 *
 * Bun exposes Node-compatible path behavior, so these layers reuse the shared
 * Node path implementation. The default `layer` follows the host operating
 * system's path rules, including separators, absolute paths, drive letters, and
 * UNC paths where applicable. Use `layerPosix` or `layerWin32` when code needs
 * stable POSIX or Windows semantics regardless of where Bun is running. These
 * layers only manipulate path strings; they do not read the filesystem, validate
 * that paths exist, or turn request URLs into safe local paths. `BunServices`
 * already includes the default Bun path layer, so provide this module directly
 * when you need only `Path` or one of the platform-specific variants.
 *
 * @since 4.0.0
 */
export * as BunPath from "./BunPath.ts"

/**
 * Bun Redis integration backed by Bun's built-in `RedisClient`.
 *
 * This module provides scoped layers that create a Bun `RedisClient` and expose
 * both the low-level `Redis` service used by Effect persistence modules and the
 * `BunRedis` service for direct access to the underlying client. Use it in Bun
 * applications that need Redis-backed persistence, persisted queues,
 * distributed rate limiting, custom Redis commands, or Bun Redis features such
 * as pub/sub through the raw client.
 *
 * The client is acquired when the layer is built and closed with `close` when
 * the layer scope ends, so install the layer at the lifetime you want for the
 * connection and pass a Redis URL, Bun `RedisOptions`, or `layerConfig` for
 * connection settings. The portable `Redis` service sends ordinary commands
 * through `RedisClient.send`; pub/sub is available through `BunRedis.client`
 * or `BunRedis.use` and should normally use a separately scoped client so a
 * subscription does not interfere with command traffic used by persistence or
 * rate limiter stores.
 *
 * Persistence and rate limiter stores build keys and Lua scripts on top of this
 * service. Choose stable prefixes and store ids to avoid collisions, account
 * for persisted values that may fail to decode after schema changes, and avoid
 * unbounded high-cardinality rate-limit keys unless you have a cleanup or
 * bounding strategy.
 *
 * @since 4.0.0
 */
export * as BunRedis from "./BunRedis.ts"

/**
 * Bun entry-point helpers for running Effect programs.
 *
 * This module exposes `runMain`, the Bun runtime launcher used at the edge of
 * CLIs, scripts, servers, and worker processes. It runs an already
 * self-contained Effect as the process main program, using the shared
 * Node-compatible runtime implementation for error reporting, teardown, and
 * `process` signal handling available in Bun.
 *
 * `BunRuntime` does not provide application services by itself. Provide any
 * required layers, such as `BunServices.layer` or narrower service-specific
 * layers, before passing the effect to `runMain`. On `SIGINT` or `SIGTERM`,
 * the main fiber is interrupted so scoped resources and finalizers can shut
 * down; keep long-running servers, workers, and subscriptions attached to that
 * scope and avoid finalizers that never complete, otherwise process shutdown
 * can be delayed.
 *
 * @since 4.0.0
 */
export * as BunRuntime from "./BunRuntime.ts"

/**
 * Provides the aggregate Bun platform services layer for applications that run
 * on the Bun runtime.
 *
 * This module is useful when an application needs the standard Bun-backed
 * implementations of filesystem access, path operations, stdio, terminal
 * interaction, and child process spawning from a single layer. Provide
 * `BunServices.layer` near the edge of a program to satisfy effects that read
 * or write files, resolve paths, interact with stdin/stdout/stderr or a
 * terminal, or launch subprocesses.
 *
 * The layer only supplies the runtime services listed by `BunServices`; it does
 * not provide unrelated platform services such as HTTP clients, HTTP servers,
 * sockets, workers, or Redis. Several of these core Bun services are backed by
 * the shared Node-compatible implementations used by the Bun adapters, so the
 * default path, stdio, terminal, and subprocess behavior follows the current
 * process and host platform. Libraries should continue to depend on the
 * individual service tags they use, while Bun applications, CLIs, and tests can
 * choose this layer or narrower service-specific layers depending on how much
 * of the Bun runtime they want to expose.
 *
 * @since 4.0.0
 */
export * as BunServices from "./BunServices.ts"

/**
 * @since 4.0.0
 */
export * as BunSink from "./BunSink.ts"

/**
 * Bun platform socket entry point for Effect sockets backed by Bun-compatible
 * Node streams and Bun's native WebSocket implementation.
 *
 * This module re-exports the shared Node socket constructors for TCP clients,
 * Unix domain socket clients, and adapters from existing Node `Duplex` streams,
 * then adds Bun-specific WebSocket layers using `globalThis.WebSocket`. Use it
 * in Bun applications that connect to raw socket protocols, Unix sockets,
 * realtime WebSocket services, or Effect RPC transports that need a
 * `Socket.Socket` layer.
 *
 * TCP lifecycle behavior comes from the shared Node layer: sockets are scoped,
 * finalizers close or destroy the underlying stream, open timeouts become
 * socket open errors, and read, write, and close events are mapped to
 * `SocketError` values. TLS concerns depend on the transport being used: `wss:`
 * URLs are handled by Bun's WebSocket implementation, while TLS-wrapped
 * `Duplex` streams can be adapted after they have been created elsewhere.
 * When closing intentionally, send `Socket.CloseEvent` values so the close code
 * and reason are preserved through the socket lifecycle.
 *
 * @since 4.0.0
 */
export * as BunSocket from "./BunSocket.ts"

/**
 * @since 4.0.0
 */
export * as BunSocketServer from "./BunSocketServer.ts"

/**
 * Bun-backed implementation of Effect's `Stdio` service.
 *
 * This module provides the process stdio layer for Bun applications by reusing
 * the shared Node-compatible implementation. The layer connects `Stdio` to the
 * current Bun process: arguments come from `process.argv`, input is read from
 * `process.stdin`, and output and error output write to `process.stdout` and
 * `process.stderr`. It is intended for CLIs, scripts, command runners, test
 * harnesses, and other process-oriented programs that need standard input and
 * output through Effect services.
 *
 * The underlying stdio streams are global resources owned by the Bun process.
 * The layer keeps stdin open and does not end stdout or stderr by default,
 * which avoids closing handles that prompts, loggers, or other code may still
 * use. Stdio may be attached to a TTY, pipe, or redirected file, so
 * terminal-specific behavior such as raw mode, echo, colors, cursor control,
 * and terminal dimensions should be coordinated with terminal APIs rather than
 * assumed from this layer.
 *
 * @since 4.0.0
 */
export * as BunStdio from "./BunStdio.ts"

/**
 * Bun stream interoperability for Effect streams.
 *
 * This module provides Bun-specific adapters for working with streaming data at
 * the boundary between Bun APIs and Effect. It re-exports the shared Node stream
 * adapters for Bun's Node-compatible stream APIs, and adds an optimized
 * `ReadableStream` constructor that uses Bun's `readMany` support to pull
 * batches of Web Stream values into an Effect `Stream`.
 *
 * Common uses include adapting Bun `Request` and `Response` bodies, multipart
 * uploads, and other Web `ReadableStream` sources so they can be transformed,
 * decoded, or piped with Effect stream operators. Pulling from the Effect stream
 * drives reads from the underlying reader, while Bun and the Web Streams runtime
 * still control their own internal buffering and source backpressure.
 *
 * Web `ReadableStream` readers take an exclusive lock on the source. Request and
 * response bodies are also one-shot: once consumed they become disturbed and
 * should not be read through another API. The adapter cancels the reader when
 * the consuming scope is finalized by default; set `releaseLockOnEnd` when the
 * stream is externally owned and should only have its lock released. Read errors
 * are mapped through the provided `onError` function.
 *
 * @since 4.0.0
 */
export * as BunStream from "./BunStream.ts"

/**
 * Bun-backed implementation of Effect's `Terminal` service.
 *
 * This module provides a scoped, process-backed terminal for Bun programs by
 * adapting the runtime's Node-compatible stdin, stdout, and `readline` support.
 * It is useful for CLIs, prompts, REPLs, and terminal interfaces that need
 * prompt output, line input, keypress input, or terminal dimensions.
 *
 * The service uses the current process streams, so acquire it with a scope or
 * provide `layer` to ensure cleanup. When stdin is attached to a TTY, raw mode
 * is enabled while the terminal is active and restored when the scope closes;
 * this changes how keys are delivered and can affect other consumers of stdin.
 * In pipes, redirected input, or CI, raw mode may be unavailable, keypress input
 * is limited, and stdout dimensions may be reported as zero.
 *
 * @since 4.0.0
 */
export * as BunTerminal from "./BunTerminal.ts"

/**
 * Parent-side Bun support for Effect workers.
 *
 * This module provides the `WorkerPlatform` used by Bun programs that spawn
 * and communicate with `globalThis.Worker` instances through Effect's worker
 * protocol. Pair it with `BunWorkerRunner` in the worker entrypoint when
 * building worker-backed RPC clients, moving CPU-bound work off the main
 * thread, isolating Bun-only services, or hosting long-lived handlers behind a
 * typed message boundary.
 *
 * The supplied spawner is responsible for creating the Bun worker for each
 * numeric worker id. Messages follow Bun's worker cloning and transfer
 * semantics, so payloads and transfer lists must be accepted by the Bun worker
 * runtime. Calls to `send` are buffered until the worker runner posts its ready
 * signal; if the worker entrypoint never starts `BunWorkerRunner`, those
 * buffered messages will not be delivered. Scope finalization sends the Effect
 * worker close signal, waits for Bun's `close` event for a short grace period,
 * and then terminates the worker if graceful shutdown does not complete.
 *
 * @since 4.0.0
 */
export * as BunWorker from "./BunWorker.ts"

/**
 * Bun runtime support for Effect worker runners.
 *
 * This module is intended for code that is already executing inside a Bun
 * `Worker`. It provides the `WorkerRunnerPlatform` used by `WorkerRunner` to
 * receive request messages from the parent, run the registered Effect handler,
 * and send responses back over Bun's worker `postMessage` channel.
 *
 * Use it with `BunWorker` when a Bun program needs to move RPC handlers,
 * CPU-bound computations, or Bun-only services into an isolated worker while
 * communicating through the Effect worker protocol. The runner must be started
 * from the worker entrypoint, not the parent process; startup fails when the
 * current global worker scope does not expose `postMessage`. Shutdown is driven
 * by the parent protocol message, which closes the worker port, so long-running
 * handlers should remain interruptible and keep resource cleanup in scopes.
 * Messages follow Bun's worker cloning and transfer semantics, so payload
 * schemas, transfer lists, `messageerror` events, and worker `error` events
 * should be considered at the boundary.
 *
 * @since 4.0.0
 */
export * as BunWorkerRunner from "./BunWorkerRunner.ts"
