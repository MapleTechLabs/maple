/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * The `Activity` module defines named, schema-backed effects that run at the
 * side-effect boundary of a durable workflow. Activities are executed through a
 * `WorkflowEngine`, encode their success and failure values with the provided
 * schemas, and can be replayed from persisted results instead of rerunning the
 * underlying effect.
 *
 * Use activities for work that should not be embedded directly in workflow
 * control flow, such as calling external services, writing to databases,
 * enqueueing durable jobs, short sleeps delegated by `DurableClock`, or racing
 * multiple external operations with `raceAll`. Keep activity names and schemas
 * stable because engines use them, together with the workflow execution and
 * retry attempt, to identify stored results.
 *
 * Activities can be interrupted and retried, and workflow resumes may observe a
 * completed encoded result or run the activity again depending on what the
 * engine has persisted. Make external side effects idempotent, use
 * `idempotencyKey` for stable request keys derived from the workflow execution,
 * and include the current attempt only when each retry must address a distinct
 * external operation.
 *
 * @since 4.0.0
 */
export * as Activity from "./Activity.ts"

/**
 * Durable workflow clocks provide workflow-safe timers and sleep operations.
 *
 * Use this module when a workflow needs to pause until a timeout, reminder,
 * deadline, retry delay, or other scheduled wake-up. Short sleeps can run as
 * in-memory activities, while longer sleeps are scheduled with the workflow
 * engine and resumed through a durable deferred signal when the timer fires.
 *
 * Because workflows may be replayed, timer names and durations should be
 * deterministic and stable for a given workflow path. Avoid deriving them from
 * ambient wall-clock state, and give distinct sleeps distinct names so replayed
 * executions can be matched with the correct scheduled wake-up. Lower the
 * in-memory threshold when a delay must be handled by the workflow engine
 * rather than the current process.
 *
 * @since 4.0.0
 */
export * as DurableClock from "./DurableClock.ts"

/**
 * Durable deferreds are named workflow wait points whose result is stored by
 * the workflow engine as an encoded `Exit`. A workflow can `await` one and
 * suspend until an activity, worker, timer, or external callback completes it
 * with `done`, `succeed`, `fail`, or `failCause`.
 *
 * Use this module to coordinate work that finishes outside the current
 * workflow turn: durable races, queues that report worker results, timers,
 * human approvals, webhooks, and other callback-style integrations. Tokens
 * encode the workflow name, execution ID, and deferred name so completion can
 * be routed back to the correct workflow execution without keeping an
 * in-memory handle.
 *
 * Deferred names are part of persisted workflow state, so keep them stable
 * across replays and unique for each logical wait. Completion is persisted as
 * an `Exit` and decoded through the success and error schemas when awaited
 * again; changing schemas or reusing a name for a different result type can
 * make old completions fail to decode or resume the wrong wait. Complete a
 * deferred once, and use `withActivityAttempt` when an activity retry needs an
 * attempt-scoped completion name.
 *
 * @since 4.0.0
 */
export * as DurableDeferred from "./DurableDeferred.ts"

/**
 * Durable queues bridge workflow executions with persisted background workers.
 * A workflow calls `process` to enqueue a schema-encoded payload in a named
 * `PersistedQueue`, attach a durable deferred token, and suspend until a worker
 * records the handler's `Exit` back through that deferred.
 *
 * Use this module for workflow steps that should be delegated to independent
 * workers: long-running side effects, rate-limited or concurrency-limited
 * integrations, fan-out jobs, API calls, and other work that must survive
 * workflow suspension, process restarts, or handoff to another service.
 *
 * Queue names, payload schemas, result schemas, and idempotency keys become
 * persisted coordination state. Keep them deterministic and stable across
 * deployments; changing them is a persistence migration. Delivery follows the
 * underlying `PersistedQueue` semantics, so handlers should be idempotent and
 * prepared for retries, duplicate observations, and worker restarts.
 *
 * @since 4.0.0
 */
export * as DurableQueue from "./DurableQueue.ts"

/**
 * The `Workflow` module defines typed durable workflow descriptions and the
 * helpers used to execute them through a `WorkflowEngine`. A workflow combines
 * a stable name, a struct payload schema, success and error schemas, and an
 * idempotency key so callers can derive deterministic execution IDs, execute or
 * discard runs, poll results, interrupt or resume suspended executions, and
 * register handlers with `toLayer`.
 *
 * Workflows are intended for long-running business processes that coordinate
 * activities, durable deferreds, durable clocks, retries, and compensation.
 * Keep external side effects at activity boundaries so engine implementations
 * can safely persist, suspend, and resume execution state. Running activities
 * can delay workflow suspension until they finish or suspend, and compensation
 * registered with `withCompensation` only applies to top-level workflow
 * effects, not nested activities.
 *
 * When exposing workflows through `WorkflowProxy`, remember that proxy APIs are
 * derived from the workflow name and schemas. Discard execution returns the
 * `executionId` instead of the workflow result, resume requires the persisted
 * `executionId`, and idempotency keys must remain stable for the same logical
 * request.
 *
 * @since 4.0.0
 */
export * as Workflow from "./Workflow.ts"

/**
 * Workflow engine service definitions and the default in-memory engine used to
 * run durable workflows.
 *
 * This module is the runtime boundary for `Workflow` values. It registers
 * workflow handlers, starts or polls executions by stable execution ID, links
 * child workflow interruption to parents, and coordinates activities, durable
 * deferred values, and durable clocks. Library users usually depend on the
 * typed `WorkflowEngine` service, while persistence backends implement the
 * lower-level `Encoded` contract and pass it to `makeUnsafe`.
 *
 * Durable execution requires engine implementations to make retries and resumes
 * idempotent. Reusing an execution ID should observe the existing execution
 * instead of starting duplicate work, suspended executions are retried according
 * to `suspendedRetrySchedule`, and concurrent deferred completions or clock
 * wake-ups must be serialized by the backend. Use `interrupt` when
 * compensation and child workflow cleanup matter; `interruptUnsafe` can stop
 * work more directly but may bypass those guarantees. The provided
 * `layerMemory` is useful for tests and local development, but it keeps state
 * in process memory and does not provide production durability.
 *
 * @since 4.0.0
 */
export * as WorkflowEngine from "./WorkflowEngine.ts"

/**
 * The `WorkflowProxy` module derives transport contracts from durable
 * `Workflow` definitions.
 *
 * Use it when workflows should be invoked through RPC or HTTP instead of by
 * importing the workflow implementation directly. `toRpcGroup` creates the
 * `RpcGroup` that RPC clients and servers share, while `toHttpApiGroup` creates
 * the `HttpApiGroup` that can be mounted in an HTTP API. Each workflow expands
 * into execute, discard, and resume operations so external callers can start a
 * workflow, start it through the discard path, or resume a suspended execution
 * by `executionId`.
 *
 * The generated names and schemas come from the workflow definitions, so keep
 * workflow names stable and pass the same workflow list to the matching
 * `WorkflowProxyServer` layer. RPC proxies may be prefixed, but the same prefix
 * must be used by the server handlers. HTTP endpoint paths are derived from the
 * lower-cased workflow name. Preserve workflow arrays as const tuples when you
 * want the generated RPC and HTTP API types to retain each workflow's literal
 * name, payload, success, and error types.
 *
 * Discard and resume are control operations rather than ordinary workflow
 * result reads. The discard proxy does not expose the normal success or error
 * schemas, and resume expects the persisted `executionId`; it cannot recreate
 * that boundary value from the original payload.
 *
 * @since 4.0.0
 */
export * as WorkflowProxy from "./WorkflowProxy.ts"

/**
 * The `WorkflowProxyServer` module provides server-side layers for exposing
 * workflows through the proxy APIs generated by `WorkflowProxy`. It connects
 * HTTP API endpoints or RPC handlers to the supplied workflow definitions,
 * routing execute, discard, and resume requests to the corresponding workflow
 * operation while keeping the `WorkflowEngine` and workflow implementation
 * services on the server side.
 *
 * **Common tasks**
 *
 * - Serve a workflow proxy over an HTTP API group with {@link layerHttpApi}
 * - Serve the RPC group produced by `WorkflowProxy.toRpcGroup` with
 *   {@link layerRpcHandlers}
 * - Expose durable workflow starts and explicit resume operations to clients
 *   without exposing the workflow implementation itself
 *
 * **Gotchas**
 *
 * - The workflows passed to these layers must match the group produced by
 *   `WorkflowProxy`; RPC prefixes must be the same on both sides
 * - Discard handlers use the workflow discard execution path, so callers should
 *   not rely on receiving the normal workflow success or error value
 * - Resume handlers expect a payload with the persisted `executionId`; clients
 *   must preserve that boundary value because it is not recomputed from the
 *   original workflow payload
 *
 * @since 4.0.0
 */
export * as WorkflowProxyServer from "./WorkflowProxyServer.ts"
