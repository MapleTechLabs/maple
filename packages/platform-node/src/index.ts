/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * @since 4.0.0
 */
export * as Mime from "./Mime.ts"

/**
 * Node.js implementation of `ChildProcessSpawner`.
 *
 * @since 4.0.0
 */
export * as NodeChildProcessSpawner from "./NodeChildProcessSpawner.ts"

/**
 * The `NodeClusterHttp` module provides the Node.js HTTP and WebSocket
 * transports for Effect Cluster runners. It wires `HttpRunner` to the Node HTTP
 * server, supplies Undici and WebSocket client protocols, and builds a complete
 * sharding layer with serialization, runner health, runner storage, and message
 * storage.
 *
 * **Common tasks**
 *
 * - Run a Node process as a cluster runner over HTTP or WebSocket with
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
export * as NodeClusterHttp from "./NodeClusterHttp.ts"

/**
 * The `NodeClusterSocket` module provides the Node.js socket transport for
 * Effect Cluster runners. It wires `SocketRunner` to Node TCP sockets, supplies
 * RPC client and server protocol layers, and builds a complete sharding layer
 * with serialization, runner health, runner storage, and message storage.
 *
 * **Common tasks**
 *
 * - Run a Node process as a cluster runner over raw TCP sockets with
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
 * - Ping health checks use the same socket protocol, so unreachable ports,
 *   firewalls, or serialization mismatches can make a runner appear unhealthy
 *
 * @since 4.0.0
 */
export * as NodeClusterSocket from "./NodeClusterSocket.ts"

/**
 * Node.js platform Crypto service layer.
 *
 * @since 1.0.0
 */
export * as NodeCrypto from "./NodeCrypto.ts"

/**
 * Provides the Node.js `FileSystem` layer for Effect programs.
 *
 * Use this module when a Node application, CLI, script, or test needs to
 * satisfy the `FileSystem` service with real filesystem access for reading and
 * writing files, creating directories and temporary files, inspecting metadata,
 * managing links, or watching paths for changes.
 *
 * This module only exposes the Node-backed layer; filesystem operations are
 * accessed through the `FileSystem` service from `effect/FileSystem`. Provide
 * `NodeFileSystem.layer` at the edge of the program, or use
 * `NodeServices.layer` when you also want the standard Node path, stdio,
 * terminal, and child process services. The implementation is shared with
 * other Node-compatible platform packages, so optional services such as
 * `FileSystem.WatchBackend` are honored when present; otherwise file watching
 * follows Node's `node:fs.watch` behavior. Paths are interpreted by Node, so
 * relative paths use the current working directory and platform path rules.
 *
 * @since 4.0.0
 */
export * as NodeFileSystem from "./NodeFileSystem.ts"

/**
 * Node.js implementations of the Effect `HttpClient`.
 *
 * This module provides the Node-specific layers and constructors for sending
 * Effect HTTP client requests. It re-exports the fetch-based client for
 * programs that want to use `globalThis.fetch`, provides an Undici-backed
 * client for applications that need Undici dispatcher control, and provides a
 * lower-level `node:http` / `node:https` client for integrations that need
 * native Node agent configuration.
 *
 * Use these clients in server-side applications, CLIs, tests, and integrations
 * where requests should participate in Effect resource management, interruption,
 * streaming, and typed transport / decode errors. The Undici path sends each
 * request through the current `Dispatcher`; `layerUndici` owns a scoped
 * `Agent`, while `dispatcherLayerGlobal` uses Undici's process-global dispatcher
 * without destroying it. The `node:http` path uses separate scoped HTTP and
 * HTTPS agents, making it the right choice when native agent options such as
 * TLS, proxy, keep-alive, or socket behavior need to be configured directly.
 *
 * The backends are not completely interchangeable. Fetch, Undici, and
 * `node:http` expose different agent and dispatcher hooks, body implementations,
 * abort behavior, upgrade support, and response body readers. This module
 * converts Effect request bodies to the selected runtime representation:
 * streams remain streaming, `FormData` may contribute generated content headers,
 * and body read failures are reported as `HttpClientError` decode or transport
 * errors.
 *
 * @since 4.0.0
 */
export * as NodeHttpClient from "./NodeHttpClient.ts"

/**
 * Utilities for adapting Node `http.IncomingMessage` values to the Effect HTTP
 * incoming message interface used by the platform Node server and client
 * implementations.
 *
 * This module is useful when code needs to keep access to Node's request or
 * response object while also exposing Effect's typed headers, remote address,
 * body decoders, and stream interface. The body helpers consume Node's readable
 * stream, cache decoded text and array-buffer results, and honor the
 * `HttpIncomingMessage.MaxBodySize` fiber ref. Prefer a single body access
 * strategy per message: raw `stream` access is not cached, and Node request
 * bodies cannot be replayed once the underlying stream has been consumed.
 *
 * @since 4.0.0
 */
export * as NodeHttpIncomingMessage from "./NodeHttpIncomingMessage.ts"

/**
 * Node.js implementation of the Effect HTTP platform service.
 *
 * This module connects the portable `HttpPlatform` file response helpers to
 * Node runtime primitives. It is used by Node HTTP servers and static file
 * handlers when returning local files, public assets, downloads, byte ranges,
 * or Web `File` values as `HttpServerResponse` bodies.
 *
 * Path-based responses are served with `node:fs.createReadStream`; Web `File`
 * responses are bridged with `Readable.fromWeb`. The implementation fills in
 * `content-type` from `Mime`, falls back to `application/octet-stream`, and
 * writes the `content-length` for the selected range or whole file. Node's
 * stream `end` option is inclusive, so the platform converts Effect's half-open
 * range before reading. Empty bodies use an empty readable stream.
 *
 * Provide `layer` at the Node runtime edge when file responses, static serving,
 * or response bodies created from files need real filesystem and ETag support.
 * These responses are raw Node streams, so they are intended for the Node HTTP
 * server adapter; keep files available until the response body has been
 * consumed and prefer the portable `HttpServerResponse` constructors when a
 * response does not depend on Node file or stream behavior.
 *
 * @since 4.0.0
 */
export * as NodeHttpPlatform from "./NodeHttpPlatform.ts"

/**
 * Node.js implementation of the Effect `HttpServer`.
 *
 * This module adapts a supplied Node `http.Server` into Effect's
 * platform-independent HTTP server service. It starts the server with Node
 * `listen` options, converts `request` events into `HttpServerRequest` values,
 * writes `HttpServerResponse` bodies through Node's `ServerResponse`, and
 * handles `upgrade` events by exposing the upgraded socket through
 * `HttpServerRequest.upgrade`.
 *
 * Common use cases include serving an Effect HTTP application with {@link layer}
 * or {@link layerConfig}, embedding request or upgrade handlers into an
 * existing Node server with {@link makeHandler} and {@link makeUpgradeHandler},
 * and using {@link layerTest} for integration tests that need an ephemeral
 * listening port and a client pointed at it.
 *
 * Listen options are passed directly to Node, so host, port, backlog, and Unix
 * socket path behavior follow `node:http`. The server begins listening when the
 * `HttpServer` is acquired, and handlers are installed when `serve` is run.
 * Request fibers are interrupted with `ClientAbort` when the client disconnects
 * before a response finishes. WebSocket support only applies to Node `upgrade`
 * requests, and ordinary HTTP requests fail if their application attempts to use
 * `HttpServerRequest.upgrade`.
 *
 * Scope ownership is important: the server is closed when the acquiring scope
 * finalizes, while each `serve` call installs its own request and upgrade
 * listeners and removes them on finalization. Unless preemptive shutdown is
 * disabled, finalizing a serve scope also starts a graceful server close, using
 * the configured timeout or the default timeout.
 *
 * @since 4.0.0
 */
export * as NodeHttpServer from "./NodeHttpServer.ts"

/**
 * Accessors for the Node.js objects backing a platform Node
 * `HttpServerRequest`.
 *
 * Use this module at interop boundaries when an Effect HTTP handler needs the
 * original `http.IncomingMessage` or `http.ServerResponse` for APIs that are
 * specific to Node, such as existing middleware, socket inspection, raw stream
 * piping, or response customization that cannot be expressed with the portable
 * `HttpServerRequest` and `HttpServerResponse` interfaces.
 *
 * The returned request is the original Node request supplied to the server. It
 * does not reflect Effect request overrides made by middleware, such as a
 * rewritten URL, adjusted headers, or a substituted remote address. Its body is
 * also Node's one-shot readable stream, so avoid mixing raw stream consumption
 * with Effect body, multipart, or stream helpers unless ownership of the body
 * is clear. The returned response is the Node response owned by the platform
 * server; writing to it directly bypasses the usual Effect response writer and
 * must be coordinated carefully to avoid duplicate writes. Upgrade requests may
 * create that response lazily when it is first requested.
 *
 * @since 4.0.0
 */
export * as NodeHttpServerRequest from "./NodeHttpServerRequest.ts"

/**
 * Node-specific helpers for parsing HTTP `multipart/form-data` request bodies.
 *
 * This module adapts a Node `Readable` request body plus its incoming headers
 * into the shared `Multipart` model. Use `stream` when an HTTP server route
 * wants to handle form fields and uploaded files incrementally, for example API
 * endpoints that validate text fields while piping file parts to storage. Use
 * `persisted` when the whole form should be collected into a record and uploaded
 * files should be written into scoped temporary files through the current
 * `FileSystem` and `Path` services.
 *
 * Node request bodies are one-shot streams, so consume either `stream` or
 * `persisted`, and make sure file parts are drained, piped, or otherwise
 * deliberately handled. `contentEffect` loads a file into memory and should be
 * reserved for small uploads. Persisted paths live only for the surrounding
 * `Scope`, and filenames supplied by clients should be treated as metadata, not
 * trusted filesystem paths.
 *
 * @since 4.0.0
 */
export * as NodeMultipart from "./NodeMultipart.ts"

/**
 * Node.js layers for Effect's `Path` service.
 *
 * Use this module when an Effect program running on Node needs path operations
 * from the `Path` service, such as joining and normalizing filesystem
 * locations, resolving configuration or static asset paths, working with CLI
 * path arguments, or converting between file paths and `file:` URLs.
 *
 * `layer` follows the host platform's `node:path` semantics. Use `layerPosix`
 * or `layerWin32` when code needs stable POSIX or Windows behavior regardless
 * of the operating system. These layers provide only path manipulation; they do
 * not read the filesystem or validate that paths exist. `NodeServices.layer`
 * already includes the default Node path layer, so provide this module directly
 * when you want the narrower service or one of the platform-specific variants.
 *
 * @since 4.0.0
 */
export * as NodePath from "./NodePath.ts"

/**
 * Node.js Redis integration backed by `ioredis`.
 *
 * This module provides scoped layers that create an `ioredis` client and expose
 * both the low-level `Redis` service used by Effect persistence modules and the
 * `NodeRedis` service for direct access to the underlying client. It is useful
 * for Node applications that want Redis-backed persistence, persisted queues,
 * distributed rate limiting, or custom Redis commands alongside the Effect
 * services that build on Redis.
 *
 * The client is acquired when the layer is built and closed with `quit` when
 * the layer scope ends, so install the layer at the lifetime you want for the
 * connection and pass `ioredis` options, or `layerConfig`, for connection,
 * TLS, database, retry, and reconnect settings. Persistence and rate limiter
 * stores build their own keys and Lua scripts on top of this service; choose
 * stable prefixes and store ids to avoid collisions, account for persisted
 * values that may fail to decode after schema changes, and avoid unbounded
 * high-cardinality rate-limit keys unless you have a cleanup or bounding
 * strategy.
 *
 * @since 4.0.0
 */
export * as NodeRedis from "./NodeRedis.ts"

/**
 * Node.js entry-point helpers for running Effect programs.
 *
 * This module exposes `runMain`, the Node runtime launcher used at the edge of
 * CLI tools, scripts, servers, and worker processes. It runs an already
 * self-contained Effect as the process main program, with built-in error
 * reporting and Node signal handling.
 *
 * `NodeRuntime` does not provide application services by itself. Provide any
 * required layers, such as `NodeServices.layer` or narrower service-specific
 * layers, before passing the effect to `runMain`. On `SIGINT` or `SIGTERM`,
 * the main fiber is interrupted so scoped resources and finalizers can shut
 * down; keep long-running work attached to that scope and avoid finalizers that
 * never complete, otherwise process shutdown can be delayed.
 *
 * @since 4.0.0
 */
export * as NodeRuntime from "./NodeRuntime.ts"

/**
 * Provides the aggregate Node platform services layer for applications that run
 * on the Node.js runtime.
 *
 * This module is useful when an application needs the standard Node-backed
 * implementations of filesystem access, path operations, stdio, terminal
 * interaction, and child process spawning from a single layer. Provide
 * `NodeServices.layer` near the edge of a program to satisfy effects that read
 * or write files, resolve paths, interact with stdin/stdout/stderr or a
 * terminal, or launch subprocesses.
 *
 * The layer only supplies the runtime services listed by `NodeServices`; it does
 * not provide unrelated platform services such as HTTP clients or servers.
 * Libraries should continue to depend on the individual service tags they use,
 * while applications, CLIs, and tests can choose this layer or narrower
 * service-specific layers depending on how much of the Node runtime they want to
 * expose.
 *
 * @since 4.0.0
 */
export * as NodeServices from "./NodeServices.ts"

/**
 * @since 4.0.0
 */
export * as NodeSink from "./NodeSink.ts"

/**
 * Node platform socket entry point for Effect sockets backed by Node streams
 * and WebSocket implementations.
 *
 * This module re-exports the shared Node socket constructors for TCP clients,
 * Unix domain socket clients, and adapters from existing Node `Duplex` streams,
 * then adds Node-specific WebSocket constructor layers. Use it when connecting
 * to raw socket protocols, wiring RPC transports over TCP or Unix sockets, or
 * opening WebSocket clients in Node.
 *
 * TCP and Unix socket behavior comes from the shared Node layer: Unix sockets
 * are selected with `NetConnectOpts.path`, scoped sockets close or destroy the
 * underlying stream on finalization, and Node open, read, write, and close
 * events are translated into `SocketError` values. For WebSockets,
 * `layerWebSocketConstructor` prefers `globalThis.WebSocket` when available
 * and falls back to `ws`; use `layerWebSocketConstructorWS` when you need the
 * `ws` implementation consistently across Node versions.
 *
 * @since 4.0.0
 */
export * as NodeSocket from "./NodeSocket.ts"

/**
 * @since 4.0.0
 */
export * as NodeSocketServer from "./NodeSocketServer.ts"

/**
 * Node.js implementation of the Effect `Stdio` service.
 *
 * This module exposes a layer that connects `Stdio` to the current process:
 * command-line arguments come from `process.argv`, input is read from
 * `process.stdin`, and output and error output write to `process.stdout` and
 * `process.stderr`. It is intended for CLIs, scripts, command runners, and
 * other process-oriented programs that need standard input and output through
 * Effect services.
 *
 * The underlying streams are owned by the Node process. The layer keeps stdin
 * open and does not end stdout or stderr when a stream finishes, which avoids
 * closing global process handles that other code may still use. Be mindful that
 * stdio may be a pipe, file, or TTY, so terminal-specific behavior such as raw
 * mode, echo, colors, and cursor control should be handled with the terminal
 * APIs instead of assuming an interactive console.
 *
 * @since 4.0.0
 */
export * as NodeStdio from "./NodeStdio.ts"

/**
 * @since 4.0.0
 */
export * as NodeStream from "./NodeStream.ts"

/**
 * Provides the Node.js `Terminal` service for interactive command-line
 * programs, prompts, and tools that need to read lines, react to key presses,
 * write to stdout, or inspect terminal dimensions.
 *
 * The implementation is backed by the current process' stdin and stdout. When
 * stdin is a TTY, key input temporarily enables raw mode for the scope of the
 * service, so callers should acquire it with a scope or use the provided layer
 * to ensure terminal state is restored. In non-TTY environments, terminal
 * dimensions may be reported as zero and raw-mode key handling is unavailable.
 *
 * @since 4.0.0
 */
export * as NodeTerminal from "./NodeTerminal.ts"

/**
 * Parent-side Node.js support for Effect workers.
 *
 * This module provides the `WorkerPlatform` used by Node programs that spawn
 * and communicate with `node:worker_threads` workers or IPC-enabled child
 * processes through Effect's worker protocol. Pair it with `NodeWorkerRunner`
 * in the worker entrypoint when building worker-backed RPC clients, offloading
 * CPU-bound work, isolating Node resources, or hosting services that should
 * exchange typed messages with the parent process.
 *
 * Worker-thread spawners can use `postMessage` transfer lists for values such
 * as `ArrayBuffer` and `MessagePort`, but transferring moves ownership and
 * invalid transfer lists surface as worker send or receive failures.
 * Child-process spawners must provide an IPC channel, for example via
 * `child_process.fork` or `stdio: "ipc"`; their messages use Node IPC
 * serialization and this module does not forward transfer lists to
 * `ChildProcess.send`. Scope finalization sends the worker close signal and
 * waits for exit before falling back to `terminate()` or `SIGKILL`.
 *
 * @since 4.0.0
 */
export * as NodeWorker from "./NodeWorker.ts"

/**
 * Runtime support for Effect workers that are executed by Node.js.
 *
 * This module is intended to be installed in the program running inside a
 * `node:worker_threads` worker or an IPC-enabled child process. It provides the
 * `WorkerRunnerPlatform` used by `WorkerRunner` to receive request messages
 * from the parent, run the registered Effect handler, and send responses back
 * over the parent channel.
 *
 * Use it when the parent side is created with `NodeWorker` and the worker code
 * needs to perform CPU-bound work, isolate Node resources, or host services that
 * should communicate through the Effect worker protocol. The runner must be
 * started from an actual worker context: `parentPort` is required for worker
 * threads, while child processes must be spawned with an IPC channel so
 * `process.send` is available. Transfer lists only apply to worker-thread
 * `postMessage`; child-process messages go through Node IPC serialization.
 * Shutdown is coordinated by the parent message protocol, so long-running
 * handlers should remain interruptible and keep resource cleanup in scopes.
 *
 * @since 4.0.0
 */
export * as NodeWorkerRunner from "./NodeWorkerRunner.ts"

/**
 * @since 4.0.0
 */
export * as Undici from "./Undici.ts"
