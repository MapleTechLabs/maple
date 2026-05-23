/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Utilities for marking the parts of worker messages that should be transferred
 * through `postMessage` instead of copied by the structured clone algorithm.
 *
 * This module is used with worker message schemas to collect
 * `globalThis.Transferable` values while encoding a message, so the worker
 * platform can pass the collected list as the `postMessage` transfer list.
 * Common cases include sending large `Uint8Array` payloads, `ImageData` pixel
 * buffers, or `MessagePort` channels without paying for an extra copy.
 *
 * Transferable annotations do not make an otherwise unsupported value
 * structured-cloneable; the encoded message still has to be valid for
 * `postMessage`. Transferring also moves ownership to the receiver, so buffers
 * are detached from the sender after the send completes. Be careful when a
 * typed array view shares a backing buffer with other data, since collecting
 * that buffer transfers ownership of the whole buffer.
 *
 * @since 4.0.0
 */
export * as Transferable from "./Transferable.ts"

/**
 * Client-side worker primitives shared by browser, Node, and Bun platform
 * packages.
 *
 * A `WorkerPlatform` turns a numeric worker id into a long-lived `Worker`
 * client using a runtime-specific `Spawner`. This module is the low-level
 * building block used by worker-backed RPC clients and by platform adapters
 * that need to communicate with dedicated workers, shared workers,
 * `MessagePort`s, worker threads, or child-process transports while keeping
 * setup, message handling, and cleanup inside `Effect` scopes.
 *
 * The worker protocol separates spawning from message delivery. Calls to
 * `send` made before the platform reports readiness are buffered and flushed
 * after `run` receives the ready signal, so a spawned worker must eventually be
 * run or buffered messages will never leave the client. Message values are
 * passed through `postMessage`, which means callers are responsible for
 * encoding payloads into values supported by the selected runtime's structured
 * clone implementation. Transfer lists can avoid copies for buffers, ports, or
 * other transferable values, but ownership moves to the worker and invalid
 * transfer lists surface as `WorkerSendError`s. Incoming messages are handled
 * by forking each handler invocation into the worker run's `FiberSet`, so
 * processing is concurrent rather than serialized; use an explicit queue,
 * semaphore, or protocol-level acknowledgement when ordering or back pressure
 * matters.
 *
 * @since 4.0.0
 */
export * as Worker from "./Worker.ts"

/**
 * Typed error definitions for the unstable worker APIs.
 *
 * `WorkerError` is the shared error channel for `WorkerPlatform` and
 * `WorkerRunnerPlatform` implementations. The nested reason identifies where a
 * platform failure happened: spawning or setting up a worker, sending through
 * `postMessage`, receiving worker events, or handling a runtime-specific
 * failure that does not fit the other categories. This is useful when building
 * worker-backed RPC clients and servers, implementing a platform adapter, or
 * recovering differently from startup, transport, and worker-exit failures.
 *
 * Worker transports cross browser, Node, Bun, and child-process runtimes, so the
 * original cause is best treated as diagnostic data. Spawn failures can mean the
 * runner is not actually executing inside a worker context, send failures often
 * come from structured-clone or transfer-list problems, and receive failures
 * may be reported as `messageerror`, `error`, or exit events depending on the
 * runtime. The `WorkerErrorReason` schema supports encoding and decoding the
 * tagged reasons, but message payloads still need to be valid for the selected
 * worker protocol and runtime.
 *
 * @since 4.0.0
 */
export * as WorkerError from "./WorkerError.ts"

/**
 * Server-side worker runner primitives shared by the browser, Node, and Bun
 * platform packages.
 *
 * A `WorkerRunnerPlatform` is installed in code that is already running inside
 * a worker-like runtime. Starting it yields a `WorkerRunner`, which listens for
 * parent or client requests, identifies each connection with a numeric port id,
 * and sends responses back through the same transport. The main Effect use case
 * is `RpcServer.layerProtocolWorkerRunner`, but platform adapters can also use
 * these types to expose lower-level request handlers for dedicated workers,
 * shared workers, worker threads, or child-process channels.
 *
 * The wire protocol is intentionally small: inbound messages are
 * `PlatformMessage` values where `[0, payload]` is a request and `[1]` closes a
 * port. Higher-level protocols are responsible for encoding request and
 * response payloads before they cross the worker boundary. Values must still be
 * accepted by the selected runtime's message mechanism, so structured-clone
 * support, transfer lists, `messageerror` events, and single-port runtimes such
 * as Node or Bun should be considered when choosing payload schemas and
 * resource lifetimes. Handler effects run on the runtime captured by `run`, so
 * services required by the handler must be provided to the running effect.
 *
 * @since 4.0.0
 */
export * as WorkerRunner from "./WorkerRunner.ts"
