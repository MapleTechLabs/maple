/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Node.js implementation of `ChildProcessSpawner`.
 *
 * @since 4.0.0
 */
export * as NodeChildProcessSpawner from "./NodeChildProcessSpawner.ts"

/**
 * Node TCP socket integration for Effect Cluster runner communication.
 *
 * This module provides the shared Node layers used by socket-based cluster
 * transports: a client protocol that opens TCP sockets to runner addresses and
 * a socket server that listens for incoming runner RPC traffic. It is useful
 * when wiring Node or Node-compatible cluster runners, sharing the same socket
 * implementation across platform packages, or building tests and deployments
 * that need direct runner-to-runner RPC over TCP rather than HTTP.
 *
 * Cluster runners must advertise an address that peers can reach while the
 * server may listen on a different address via `runnerListenAddress`, which is
 * common behind containers, port mappings, or Kubernetes services. Serialization
 * is supplied by the surrounding layer, and gossip, shard discovery, health
 * checks, and storage-backed delivery are coordinated by the cluster services
 * that use this transport. Keep those responsibilities separate when debugging:
 * a reachable socket does not by itself guarantee that runner membership,
 * shard ownership, or persisted message notification is current.
 *
 * @since 4.0.0
 */
export * as NodeClusterSocket from "./NodeClusterSocket.ts"

/**
 * Node.js implementation of the Crypto service.
 *
 * @since 1.0.0
 */
export * as NodeCrypto from "./NodeCrypto.ts"

/**
 * Shared Node-compatible implementation of Effect's `FileSystem` service.
 *
 * This module adapts Node's `node:fs`, `node:os`, and `node:path` APIs into a
 * layer that can be provided to Effect programs running on Node-compatible
 * runtimes. It is used by platform packages to provide file and directory I/O,
 * permissions, links, metadata, temporary files and directories, and file
 * watching through the `FileSystem` service.
 *
 * Paths are passed to Node filesystem APIs, so relative paths are resolved by
 * the current working directory and platform path rules still apply. Node
 * filesystem failures are translated into `PlatformError` values, while invalid
 * arguments become `BadArgument` failures. Open files are scoped resources with
 * tracked read and write positions; append mode lets the operating system choose
 * the write offset. File watching is exposed as a stream and follows
 * `node:fs.watch` semantics unless a `WatchBackend` is provided, so recursive
 * support, event coalescing, and reported paths can vary by runtime and
 * platform.
 *
 * @since 4.0.0
 */
export * as NodeFileSystem from "./NodeFileSystem.ts"

/**
 * Shared Node-compatible implementation of Effect's `Path` service.
 *
 * This module adapts Node's `node:path` and `node:url` APIs into layers that
 * can be provided to Effect programs needing path manipulation, such as
 * resolving configuration files, building file system locations, parsing
 * names and extensions, or converting between file paths and `file:` URLs.
 *
 * The default layer follows the host platform semantics exposed by
 * `node:path`, while `layerPosix` and `layerWin32` provide stable POSIX or
 * Windows behavior regardless of the current runtime. Path operations are
 * syntactic and do not check whether files exist; separators, drive letters,
 * UNC paths, and URL encoding rules can also differ by platform. Invalid
 * file URL conversions are reported through `BadArgument`.
 *
 * @since 4.0.0
 */
export * as NodePath from "./NodePath.ts"

/**
 * Shared runtime helpers for running Effect programs as Node-compatible
 * process entry points.
 *
 * This module provides the common `runMain` implementation used by
 * Node-compatible platform packages. It is intended for CLIs, scripts,
 * workers, servers, and other process-oriented programs that should run an
 * Effect as their main fiber while still following Node process conventions.
 *
 * The runner installs `SIGINT` and `SIGTERM` handlers for the lifetime of the
 * main fiber, translating those process signals into fiber interruption so
 * Effect finalizers and the configured teardown can run. When the fiber exits,
 * the signal listeners are removed and teardown determines the exit code. Clean
 * success lets the Node event loop drain naturally instead of forcing
 * `process.exit(0)`, while signal-triggered or non-zero exits call
 * `process.exit` after teardown, so long-running resources should be modeled
 * in the Effect scope and finalized explicitly.
 *
 * @since 4.0.0
 */
export * as NodeRuntime from "./NodeRuntime.ts"

/**
 * Sink adapters for writing Effect stream chunks into Node writable streams.
 *
 * This module is used at the boundary where Effect `Stream`s or `Channel`s need
 * to push data into Node's writable side: file streams, HTTP request or
 * response bodies, process stdio, sockets, and transform inputs such as
 * compression or encryption streams. It exposes both a `Sink` constructor for
 * ordinary stream pipelines and lower-level `Channel` and pull helpers used by
 * other Node stream adapters.
 *
 * The implementation follows Node writable semantics. Chunks are written in
 * order; when `write` returns `false`, pulling pauses until `drain` so upstream
 * producers do not overrun the writable buffer. Writable `error` events are
 * mapped through `onError`, and the writable is ended and awaited via `finish`
 * when upstream completes unless `endOnDone` is `false`. Use `endOnDone: false`
 * for externally owned or long-lived writables, and make sure `onError` keeps
 * Node's untyped errors meaningful for the calling Effect workflow.
 *
 * @since 4.0.0
 */
export * as NodeSink from "./NodeSink.ts"

/**
 * Shared Node socket constructors for adapting `node:net` connections and
 * other Node `Duplex` streams to Effect's `Socket.Socket` interface.
 *
 * Use this module when building TCP clients, Unix domain socket clients, or
 * higher-level protocols that already expose a Node `Duplex`. Connections are
 * scoped, so finalizers close or destroy the underlying stream, open timeouts
 * are reported as socket open errors, and Node read, write, and close events
 * are translated into `SocketError` values.
 *
 * Node sockets have a few operational details worth keeping in mind: Unix
 * socket paths are supplied through `NetConnectOpts.path`, writes complete only
 * after Node accepts or flushes the chunk, and abnormal close events are
 * surfaced as close errors while normal remote ends complete the socket run.
 *
 * @since 4.0.0
 */
export * as NodeSocket from "./NodeSocket.ts"

/**
 * Shared Node socket server constructors for exposing `node:net` servers and
 * `ws` WebSocket servers as Effect `SocketServer.SocketServer` services.
 *
 * Use this module when implementing TCP services, Unix domain socket services,
 * WebSocket endpoints, or higher-level protocols such as RPC transports that
 * need to accept incoming connections through Effect's socket APIs. TCP
 * connections are adapted through `NodeSocket.fromDuplex`, while WebSocket
 * handlers also receive the underlying `WebSocket` and Node `IncomingMessage`
 * in their fiber context.
 *
 * The server starts listening before the constructor returns, and the exported
 * `address` is derived from the actual Node server after binding. Prefer that
 * address when using port `0`, wildcard hosts, or Unix socket paths. Incoming
 * connections accepted before `run` is installed are queued and then handed to
 * the handler, each `run` call owns the scope for its connection fibers, and
 * the enclosing scope closes the underlying Node server.
 *
 * @since 4.0.0
 */
export * as NodeSocketServer from "./NodeSocketServer.ts"

/**
 * Shared Node.js implementation of the Effect `Stdio` service.
 *
 * This module builds the `Stdio` layer used by Node platform packages by
 * wiring the service to the current process: command-line arguments come from
 * `process.argv`, input is read from `process.stdin`, and output and error
 * output are written to `process.stdout` and `process.stderr`. It is intended
 * for CLIs, scripts, command runners, test harnesses, and other
 * process-oriented programs that need standard I/O through Effect services.
 *
 * The process stdio streams are global resources owned by Node. This layer
 * leaves stdin open and does not end stdout or stderr by default, avoiding
 * accidental closure of handles other code in the process may still use. Those
 * streams may be pipes, files, or TTYs; interactive terminal behavior such as
 * raw mode, echo, colors, and cursor movement should be coordinated with the
 * terminal APIs instead of assuming this layer has exclusive control.
 *
 * @since 4.0.0
 */
export * as NodeStdio from "./NodeStdio.ts"

/**
 * Interoperability between Node streams and Effect streams and channels.
 *
 * This module adapts `Readable` and `Duplex` instances at the boundary with
 * Node APIs: wrapping sources such as files, HTTP responses, child process
 * output, and compression transforms as Effect `Stream`s or `Channel`s, piping
 * Effect streams through Node duplex transforms, exposing an Effect `Stream`
 * back to Node as a `Readable`, and collecting small readable payloads into
 * strings or binary buffers.
 *
 * The adapters preserve the Node stream semantics that matter for production
 * code. Writes wait for `drain` when a writable side applies backpressure,
 * readable streams are destroyed on scope finalization by default, and stream
 * failures are routed through `onError` or `Cause.UnknownError`. For long-lived
 * or externally owned streams, pass `closeOnDone` or `endOnDone` carefully, and
 * use `maxBytes` on collection helpers to avoid buffering unbounded input.
 *
 * @since 4.0.0
 */
export * as NodeStream from "./NodeStream.ts"

/**
 * Shared Node.js implementation of Effect's `Terminal` service.
 *
 * This module is the process-backed terminal implementation used by Node
 * platform packages. It adapts Node's `readline` APIs and the current
 * process' `stdin` and `stdout` streams into a `Terminal`, making it suitable
 * for CLIs, REPLs, prompts, full-screen terminal programs, and other
 * command-line tools that need line input, keypress input, terminal
 * dimensions, or prompt output.
 *
 * The implementation works with global process streams, so callers should
 * acquire it with a scope or provide `layer` to ensure cleanup. When `stdin`
 * is a TTY, raw mode is enabled while the scoped readline interface is active
 * and restored on release; raw mode changes how keys are delivered and can
 * affect other code reading stdin. In non-TTY environments such as pipes,
 * redirected input, or CI, raw mode is unavailable, keypress behavior is
 * limited, and stdout dimensions may be reported as zero.
 *
 * @since 4.0.0
 */
export * as NodeTerminal from "./NodeTerminal.ts"
