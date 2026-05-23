/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * The `ClusterCron` module provides a small integration between cron schedules
 * and cluster sharding. It turns a `Cron.Cron` schedule into a `Layer` that
 * coordinates one recurring job across a cluster by registering a singleton for
 * the initial scheduling step and a persisted entity message for each run.
 *
 * This is useful for distributed maintenance work such as periodic cleanup,
 * reconciliation, report generation, cache refreshes, or polling external
 * systems where the job should be owned by the cluster rather than by every
 * runner independently.
 *
 * **Mental model**
 *
 * - {@link make} registers a named cluster cron job as a layer
 * - a singleton schedules the first run for the selected shard group
 * - each run is delivered as a persisted entity message at its scheduled time
 * - after a run exits, the handler schedules the next occurrence
 * - stale runs can be skipped with `skipIfOlderThan`
 *
 * **Gotchas**
 *
 * - Job effects should be idempotent because persisted messages, retries, and
 *   runner failover are part of normal distributed execution.
 * - By default, the next run is calculated from the current time after the
 *   handler exits; use `calculateNextRunFromPrevious` when preserving the
 *   schedule cadence is more important than catching up from delays.
 * - Long outages can produce old scheduled messages; keep `skipIfOlderThan`
 *   aligned with the job's business semantics.
 *
 * @since 4.0.0
 */
export * as ClusterCron from "./ClusterCron.ts"

/**
 * The `ClusterError` module defines the typed error values used by the
 * unstable cluster runtime when routing messages to entities, coordinating
 * runners, and persisting mailbox work.
 *
 * These errors are useful when implementing cluster transports, runner
 * supervision, mailbox storage, and entity request handling. They make common
 * distributed-system failures explicit: a message may reach a runner that no
 * longer owns the entity, a runner may be unavailable or unregistered, a
 * payload may fail to decode, persistence may fail, a mailbox may be at
 * capacity, or an envelope may already be in progress.
 *
 * **Gotchas**
 *
 * - Entity ownership and runner availability can change while messages are in
 *   flight, so routing errors should generally be treated as retryable or
 *   recoverable by higher-level cluster logic.
 * - `MalformedMessage` points to a schema/serialization boundary failure,
 *   while `PersistenceError` preserves failures from durable mailbox storage.
 * - `AlreadyProcessingMessage` protects an entity mailbox from processing the
 *   same envelope concurrently.
 *
 * @since 4.0.0
 */
export * as ClusterError from "./ClusterError.ts"

/**
 * The `ClusterMetrics` module defines the standard metrics emitted by the
 * unstable cluster runtime. These gauges track the shape and health of a
 * running cluster from the perspective of runners, entities, singletons, and
 * shard ownership.
 *
 * **Common tasks**
 *
 * - Monitor how many entity instances and singleton processes are active on a
 *   runner
 * - Track registered runners and the subset currently considered healthy
 * - Observe shard distribution across runners during startup, rebalancing, and
 *   failover
 *
 * **Gotchas**
 *
 * - Runner-local gauges such as {@link entities}, {@link singletons}, and
 *   {@link shards} describe the current runner, so aggregate them carefully in
 *   dashboards
 * - Cluster-wide gauges such as {@link runners} and {@link runnersHealthy}
 *   reflect the runtime's current view, which may lag briefly during membership
 *   changes or failure detection
 *
 * @since 4.0.0
 */
export * as ClusterMetrics from "./ClusterMetrics.ts"

/**
 * The `ClusterSchema` module defines the schema annotations used by Effect
 * Cluster protocols. These annotations attach cluster-specific behavior to
 * RPCs and entities without changing the request or response schemas
 * themselves.
 *
 * **Common tasks**
 *
 * - Mark requests as persisted so mailbox storage can replay them after
 *   interruption or restart
 * - Run server-side handling inside a storage transaction when durable state
 *   and SQL updates must commit together
 * - Control whether client sending, server handling, or both are treated as
 *   uninterruptible
 * - Route entity ids into shard groups
 * - Disable client tracing for internal protocols such as cron dispatch
 * - Derive per-request annotations from the encoded request with {@link Dynamic}
 *
 * **Protocol notes**
 *
 * Cluster transports serialize the RPC payloads, not arbitrary runtime
 * annotation values. Prefer static, deterministic annotations, and use
 * {@link Dynamic} when a persisted or transactional decision depends on the
 * request value that is already part of the protocol. Persisted requests require
 * message storage support, and shard group selection must remain stable for a
 * given entity id so routing is consistent across cluster members.
 *
 * @since 4.0.0
 */
export * as ClusterSchema from "./ClusterSchema.ts"

/**
 * The cluster workflow engine runs durable workflows on top of cluster sharding
 * and message storage. It adapts `WorkflowEngine.WorkflowEngine` so workflow
 * executions, activities, deferred completions, resumes, interrupts, and durable
 * clock wakeups are represented as persisted cluster entity messages.
 *
 * **Common tasks**
 *
 * - Provide a workflow engine for services that already use cluster sharding
 * - Execute workflows by stable execution id and poll their persisted result
 * - Resume suspended workflows after activities, deferreds, or durable clock wakeups
 * - Interrupt workflow executions and propagate resume signals to parent workflows
 *
 * **Gotchas**
 *
 * - Workflow names and execution ids determine the cluster entity address used
 *   for persistence, so they must remain stable across deploys
 * - Activities are persisted by activity name and attempt; retries and suspended
 *   activity resumes depend on those primary keys
 * - Durable clock wakeups are scheduled through a separate clock entity and are
 *   cleared when an interrupted workflow stops waiting
 *
 * @since 4.0.0
 */
export * as ClusterWorkflowEngine from "./ClusterWorkflowEngine.ts"

/**
 * The `DeliverAt` module defines the protocol used by cluster message payloads
 * that carry their own scheduled delivery time. A value implements the protocol
 * by exposing a method at the `DeliverAt` symbol that returns the target
 * `DateTime`.
 *
 * **Common tasks**
 *
 * - Mark a message payload as deliverable at a specific time by implementing
 *   {@link DeliverAt}
 * - Check whether an arbitrary value carries a scheduled delivery time with
 *   {@link isDeliverAt}
 * - Convert a scheduled delivery time to epoch milliseconds with
 *   {@link toMillis}
 *
 * **Gotchas**
 *
 * - The protocol records the requested delivery instant; cluster infrastructure
 *   may still deliver later because of clock skew, queue latency, or worker
 *   availability
 * - Values that do not implement the symbol method are treated as unscheduled;
 *   {@link toMillis} returns `null` for those values
 *
 * @since 4.0.0
 */
export * as DeliverAt from "./DeliverAt.ts"

/**
 * The `Entity` module defines sharded, addressable actors for Effect Cluster.
 * An entity type pairs a stable entity name with an RPC protocol and describes
 * how requests for individual entity ids are routed to shard groups and
 * runners.
 *
 * **Mental model**
 *
 * - An `Entity` is the cluster-facing definition for one logical actor type
 * - Each entity id maps deterministically to a shard group and shard id
 * - Clients are created per entity id and send typed RPC messages through the
 *   cluster sharding layer
 * - Server layers register handlers or mailbox processors for the entity type
 *
 * **Common tasks**
 *
 * - Define an entity protocol with RPCs and create an entity with {@link make}
 * - Send messages to a specific entity id with {@link Entity.client}
 * - Register typed RPC handlers with {@link Entity.toLayer}
 * - Process envelopes directly with {@link Entity.toLayerQueue}
 * - Access the current entity or runner address with {@link CurrentAddress} and
 *   {@link CurrentRunnerAddress}
 *
 * **Gotchas**
 *
 * - Entity ids are part of routing: changing id formats can move work to
 *   different shards
 * - Entity type names should be stable and unique within a cluster deployment
 * - Mailbox capacity and concurrency determine back pressure and duplicate
 *   processing behavior
 * - Persistence, mailbox, and already-processing failures are surfaced through
 *   the generated clients
 *
 * @since 4.0.0
 */
export * as Entity from "./Entity.ts"

/**
 * The `EntityAddress` module defines the value used to locate an entity within
 * a cluster. An address combines the entity type, entity id, and shard id so
 * messages, persisted envelopes, workflow executions, and entity managers can
 * agree on the same routing target.
 *
 * **Common tasks**
 *
 * - Build an address after resolving an entity id to a shard with `Sharding`
 * - Attach an address to cluster envelopes and persisted messages
 * - Compare or hash addresses when tracking active or resuming entities
 *
 * **Gotchas**
 *
 * - The shard id is part of the address identity; the same entity type and id
 *   on a different shard is a different address.
 * - Entity ids should be routed through the same shard group logic used by the
 *   entity definition so messages are sent to the runner that owns the shard.
 *
 * @since 4.0.0
 */
export * as EntityAddress from "./EntityAddress.ts"

/**
 * The `EntityId` module provides a branded string identifier for addressing a
 * specific entity instance inside the cluster. Entity ids are commonly used as
 * stable routing keys when sending messages to an entity, looking up its state,
 * or deriving the shard responsible for that entity.
 *
 * Because routing is based on the exact string value, choose ids that are
 * deterministic, normalized, and unique within the entity type you are
 * addressing. Avoid display names or other values that may change over time.
 *
 * @since 4.0.0
 */
export * as EntityId from "./EntityId.ts"

/**
 * The `EntityProxy` module derives external RPC and HTTP API surfaces from a
 * clustered {@link Entity.Entity}. It is used when callers should communicate
 * with entities through ordinary RPC clients or HTTP routes while the cluster
 * runtime keeps responsibility for locating, routing, and delivering messages
 * to the entity instance identified by `entityId`.
 *
 * **Common tasks**
 *
 * - Derive an `RpcGroup` from an entity with {@link toRpcGroup}
 * - Derive an `HttpApiGroup` from an entity with {@link toHttpApiGroup}
 * - Expose both request/response calls and discard variants for fire-and-forget
 *   delivery
 *
 * **Gotchas**
 *
 * - Proxy RPC payloads wrap the original RPC payload with an `entityId`; HTTP
 *   endpoints place the same identifier in the route path.
 * - Generated RPC names are prefixed with the entity type, while HTTP endpoint
 *   paths are based on lower-cased RPC tags.
 * - Proxy errors include cluster delivery errors such as mailbox saturation,
 *   duplicate in-flight messages, and persistence failures.
 *
 * @since 4.0.0
 */
export * as EntityProxy from "./EntityProxy.ts"

/**
 * The `EntityProxyServer` module provides server-side layers for exposing
 * clustered entities through proxy APIs. It connects proxy requests to an
 * entity client, extracts the target `entityId`, and forwards the payload to
 * the matching entity RPC method.
 *
 * **Common tasks**
 *
 * - Serve an entity proxy over an HTTP API group with {@link layerHttpApi}
 * - Serve the RPC group produced by an entity proxy with {@link layerRpcHandlers}
 * - Route both normal calls and discard calls to the same underlying entity
 *   method
 *
 * **Gotchas**
 *
 * - HTTP proxy endpoints expect the `entityId` path parameter to identify the
 *   target entity instance
 * - RPC proxy handlers use tags prefixed with the entity type, matching the
 *   group generated by `EntityProxy.toRpcGroup`
 * - Both layers require `Sharding` and the entity RPC server services in the
 *   environment so requests can be routed to the owning shard
 *
 * @since 4.0.0
 */
export * as EntityProxyServer from "./EntityProxyServer.ts"

/**
 * The `EntityResource` module provides helpers for acquiring resources inside a
 * cluster entity and keeping them available across entity restarts. It is useful
 * for long-lived resources tied to an entity address, such as external
 * processes, network clients, Kubernetes Pods, or other handles that should not
 * be torn down during routine shard movement.
 *
 * **Common tasks**
 *
 * - Create a reusable entity-scoped resource with {@link make}
 * - Keep an entity alive while the resource is acquired
 * - Explicitly release the resource with `EntityResource.close`
 * - Attach cleanup work to the resource close scope with {@link CloseScope}
 * - Create and manage a Kubernetes Pod resource with {@link makeK8sPod}
 *
 * **Lifecycle gotchas**
 *
 * - Resources are retained by an `RcRef` and are only fully released after
 *   `idleTimeToLive` expires or `close` is called
 * - The default idle time to live is infinite, so resources remain alive until
 *   explicitly closed
 * - `CloseScope` is separate from the caller scope and is not closed by entity
 *   restarts, shard movement, or node shutdown finalization
 *
 * @since 4.0.0
 */
export * as EntityResource from "./EntityResource.ts"

/**
 * The `EntityType` module defines the branded string used to identify a kind of
 * entity in an Effect cluster. Entity type names are part of the cluster routing
 * identity: they distinguish one family of entities from another before an
 * individual entity id is considered.
 *
 * **Common tasks**
 *
 * - Declare the stable name for an entity family handled by a cluster service
 * - Brand a string literal as an {@link EntityType} with {@link make}
 * - Validate or encode entity type names with the {@link EntityType} schema
 *
 * **Gotchas**
 *
 * - Entity type names should be stable and unique within the cluster because
 *   changing them changes where entity messages are routed
 * - The entity type name identifies the entity family, not a specific entity
 *   instance; combine it with the entity id at the call site that routes work
 *
 * @since 4.0.0
 */
export * as EntityType from "./EntityType.ts"

/**
 * The `Envelope` module defines the transport messages exchanged by Effect
 * cluster entities while processing RPC requests. Envelopes wrap decoded
 * request payloads with routing metadata, trace context, and request ids, and
 * also model delivery-control messages such as streamed-reply acknowledgements
 * and request interrupts.
 *
 * **Common use cases**
 *
 * - Construct a runtime request envelope with {@link makeRequest}
 * - Decode or encode envelopes crossing a network or durable queue with {@link PartialJson}
 * - Batch encoded envelopes with {@link PartialArray}
 * - Detect envelope values at runtime with {@link isEnvelope}
 * - Build storage keys for keyed request payloads with {@link primaryKey}
 *
 * **Serialization and delivery notes**
 *
 * Request envelopes are decoded in two phases: the envelope metadata is parsed
 * first, while the RPC payload remains `unknown` until the receiving side knows
 * the target RPC schema. Snowflake identifiers are encoded as strings for JSON
 * transport, and acknowledgement / interrupt envelopes carry the original
 * request id so delivery protocols can correlate control messages with the
 * in-flight request.
 *
 * @since 4.0.0
 */
export * as Envelope from "./Envelope.ts"

/**
 * The `HttpRunner` module wires cluster runner RPCs to HTTP transports. It
 * provides client protocol layers for contacting runners over HTTP or
 * WebSocket, server-side HTTP effects for exposing runner RPC handlers, and
 * complete layers that install those routes into an `HttpRouter`.
 *
 * **Common tasks**
 *
 * - Serve runner RPC routes with {@link layerHttp} or {@link layerWebsocket}
 * - Configure client-only runner communication with {@link layerHttpClientOnly}
 *   or {@link layerWebsocketClientOnly}
 * - Use custom route paths with {@link layerHttpOptions},
 *   {@link layerWebsocketOptions}, {@link layerClientProtocolHttp}, or
 *   {@link layerClientProtocolWebsocket}
 *
 * **Transport gotchas**
 *
 * - Client protocol paths are appended to each runner address when building the
 *   target URL
 * - `https: true` switches HTTP clients from `http` to `https`, and WebSocket
 *   clients from `ws` to `wss`
 * - The default complete layers serve and connect at `/`; use the `Options`
 *   variants when your runner routes live under a different path
 *
 * @since 4.0.0
 */
export * as HttpRunner from "./HttpRunner.ts"

/**
 * The `K8sHttpClient` module provides an HTTP client service for talking to the
 * Kubernetes API from code running inside a cluster.
 *
 * It configures requests for the in-cluster service endpoint, attaches the
 * mounted service-account token when present, and exposes helpers for common
 * cluster tasks such as discovering running pods by namespace or label selector
 * and creating scoped pods that are cleaned up automatically.
 *
 * **Gotchas**
 *
 * - The default layer targets `https://kubernetes.default.svc/api`, so it is
 *   intended for workloads with Kubernetes DNS and service-account mounts.
 * - Pod discovery is keyed by pod IP address and only includes pods whose phase
 *   is `Running`; callers should choose selectors that match the intended
 *   service topology.
 * - Network policies, RBAC, and service-account token availability can all
 *   prevent the client from reaching or authorizing with the Kubernetes API.
 *
 * @since 4.0.0
 */
export * as K8sHttpClient from "./K8sHttpClient.ts"

/**
 * The `MachineId` module provides the branded integer identifier used to
 * distinguish cluster runners when generating distributed ids and coordinating
 * runner state.
 *
 * **When to use**
 *
 * - Persisting or exchanging the machine id assigned to a cluster runner
 * - Passing a runner-specific identity to the cluster snowflake generator
 * - Decoding machine ids from storage while keeping them distinct from plain numbers
 *
 * **Gotchas**
 *
 * - Machine ids must be unique for concurrently active runners that generate snowflakes
 * - Snowflake ids store the machine component in 10 bits, so only the value modulo 1024 is encoded
 *
 * @since 4.0.0
 */
export * as MachineId from "./MachineId.ts"

/**
 * The cluster `Message` module defines the in-memory shapes used while moving
 * requests and control envelopes between callers, durable storage, transports,
 * and entity runners.
 *
 * **Common use cases**
 *
 * - Representing outgoing entity requests before they are stored or sent
 * - Reconstructing incoming requests that runners read from storage or transport
 * - Converting outgoing messages into local, in-process deliveries
 * - Serializing request payloads with the associated RPC schema and context
 * - Passing control envelopes such as acknowledgements and interrupts through
 *   without payload decoding
 *
 * **Gotchas**
 *
 * - Requests can exist in decoded local form or encoded persisted form; choose
 *   `IncomingLocal` / `OutgoingRequest` for local delivery and `IncomingRequest`
 *   / `Envelope.PartialRequest` for storage or transport boundaries.
 * - Request payloads must be encoded and decoded with the matching RPC payload
 *   schema and service context, otherwise failures are surfaced as
 *   `MalformedMessage`.
 * - Delivery state such as the last sent or received reply is carried alongside
 *   messages so retries and persisted replies can preserve cluster semantics.
 *
 * @since 4.0.0
 */
export * as Message from "./Message.ts"

/**
 * The `MessageStorage` module defines the persistence boundary used by Effect
 * Cluster to store mailbox messages and replies. Storage implementations keep
 * requests, envelopes, and reply chunks durable enough for runners to recover
 * work after restarts, replay unprocessed messages for assigned shards, and
 * deliver replies back to locally registered handlers.
 *
 * **Common use cases**
 *
 * - Persist outgoing requests and control envelopes before delivery
 * - Detect duplicate requests by primary key and resume from an existing reply
 * - Query unprocessed messages when shards are assigned to a runner
 * - Store, load, and clear replies for request streams and completions
 * - Reset or clear mailbox state during shard or address lifecycle changes
 *
 * **Gotchas**
 *
 * - Implementations should make save and reply operations transactional when
 *   possible so recovery does not observe partial mailbox state
 * - Duplicate detection depends on stable request primary keys and persisted
 *   request ids
 * - Reply handlers are local process state; persisted replies may need to be
 *   loaded again after restarts or reassignment
 * - Concurrent runners must only process messages for shards they currently own
 *
 * @since 4.0.0
 */
export * as MessageStorage from "./MessageStorage.ts"

/**
 * The `Reply` module models responses produced by clustered RPC execution. A
 * reply belongs to a request and is either a terminal {@link WithExit}, which
 * carries the final RPC `Exit`, or a streaming {@link Chunk}, which carries a
 * non-empty batch of success values for RPCs that stream results.
 *
 * **Common tasks**
 *
 * - Represent runtime replies with {@link Reply}, {@link WithExit}, and {@link Chunk}
 * - Encode and decode transport payloads with {@link Encoded} and {@link Reply}
 * - Persist replies together with schema context via {@link ReplyWithContext}
 * - Serialize the latest received reply when resuming or de-duplicating requests with {@link serializeLastReceived}
 *
 * **Streaming and acknowledgement notes**
 *
 * - Chunk replies are sequenced and can be replayed until acknowledged by the
 *   receiver.
 * - A `WithExit` reply is terminal and completes the request, while chunks only
 *   represent intermediate streamed success values.
 * - `Chunk.emptyFrom` is used as an acknowledgement marker for an empty streamed
 *   reply; it is not a general-purpose success payload.
 *
 * @since 4.0.0
 */
export * as Reply from "./Reply.ts"

/**
 * The `Runner` module defines the membership record used by the unstable
 * cluster runtime to describe a process that can host entity shards.
 *
 * A runner combines the network address used by other runners to reach it, the
 * shard groups it participates in, and a relative weight used when the sharding
 * service assigns shards across the healthy runners in each group.
 *
 * **Common tasks**
 *
 * - Construct the runner registered by the local `Sharding` layer
 * - Persist or exchange runner metadata through `RunnerStorage`
 * - Encode and decode runner values at cluster transport or storage boundaries
 * - Tune shard distribution by adjusting the runner's group membership and
 *   relative weight
 *
 * **Gotchas**
 *
 * - Runner addresses must be stable and unique while a runner is registered,
 *   because they identify the owner used for routing and shard locks.
 * - Weights are relative within each shard group; changing weights or groups can
 *   rebalance shard ownership as the cluster refreshes its runner view.
 * - Runner equality and hashing are based on address and weight, so compare
 *   `groups` explicitly when group membership is the important distinction.
 *
 * @since 4.0.0
 */
export * as Runner from "./Runner.ts"

/**
 * The `RunnerAddress` module defines the network identity used to locate a
 * cluster runner. A runner address is a host and port pair that can be encoded,
 * compared, hashed, inspected, and used as a stable primary key.
 *
 * **Common use cases**
 *
 * - Representing the target runner for cluster routing and placement decisions
 * - Persisting or exchanging runner endpoints through schemas
 * - Using runner endpoints as keys in maps, registries, or shard ownership data
 *
 * **Gotchas**
 *
 * - Identity is structural: two addresses are equal when both host and port match
 * - The primary key is formatted as `host:port`, so host strings should already
 *   be normalized for the routing layer using them
 *
 * @since 4.0.0
 */
export * as RunnerAddress from "./RunnerAddress.ts"

/**
 * The `RunnerHealth` module defines the health-check service used by cluster
 * sharding to decide whether a runner may still own its assigned shards. A
 * runner that is reported as alive is allowed to keep processing messages,
 * while a runner that is reported as unavailable can have its shards moved to
 * another runner.
 *
 * **Common tasks**
 *
 * - Provide a custom {@link RunnerHealth} service for a cluster deployment
 * - Use {@link layerPing} to check runners through the cluster runner protocol
 * - Use {@link layerK8s} when Kubernetes pod readiness should drive health
 * - Use {@link layerNoop} in tests or environments where runners are always considered healthy
 *
 * **Gotchas**
 *
 * - Health checks affect shard reassignment, so false negatives can move shards
 *   away from runners that may still be processing messages
 * - The Kubernetes implementation treats API failures as healthy to avoid
 *   reassignment caused by a temporary control-plane outage
 *
 * @since 4.0.0
 */
export * as RunnerHealth from "./RunnerHealth.ts"

/**
 * The `Runners` module defines the service used by the unstable cluster runtime
 * to communicate with processes that host entity shards. It is the transport
 * boundary between sharding decisions and runner execution: callers can ping a
 * runner, send requests or envelopes, notify a runner that persisted work is
 * available, and report an address as unavailable.
 *
 * The default implementation wraps lower-level runner callbacks with cluster
 * message semantics. Persisted messages are written to `MessageStorage` before
 * delivery, duplicate requests can resume from stored replies, and local sends
 * can optionally serialize and deserialize messages to exercise the same path as
 * remote delivery.
 *
 * **Common tasks**
 *
 * - Provide runner communication with {@link layerRpc}
 * - Build a custom implementation with {@link make}
 * - Use {@link makeNoop} or {@link layerNoop} when no remote runners are
 *   available
 * - Define runner-to-runner protocol support with {@link Rpcs} and
 *   {@link RpcClientProtocol}
 *
 * **Gotchas**
 *
 * - `notify` is only for RPCs annotated as persisted; non-persisted messages
 *   should be sent directly.
 * - Failed remote sends can fall back to reading replies from storage, so reply
 *   polling and `entityReplyPollInterval` affect recovery latency.
 * - Unavailable runners invalidate cached RPC clients, but shard ownership and
 *   rebalancing are coordinated by the sharding layer rather than this module.
 *
 * @since 4.0.0
 */
export * as Runners from "./Runners.ts"

/**
 * The `RunnerServer` module provides the transport-agnostic server side of the
 * cluster runner protocol. It turns the runner RPC group into handlers that
 * receive ping, notification, request, stream, and envelope messages from other
 * runners, then forwards them into `Sharding` and coordinates persisted replies
 * through `MessageStorage`.
 *
 * **Common tasks**
 *
 * - Build a runner server once an `RpcServer.Protocol` has been supplied by a
 *   transport such as HTTP, WebSocket, or sockets
 * - Provide the complete runner runtime with `Sharding` and `Runners` clients
 *   using {@link layerWithClients}
 * - Embed a cluster client without serving runner RPCs or accepting shard
 *   assignments using {@link layerClientOnly}
 *
 * **Gotchas**
 *
 * - This module does not choose a wire transport; transport-specific modules
 *   provide the `RpcServer.Protocol`
 * - Persisted requests register reply handlers in `MessageStorage` before the
 *   message is delivered to `Sharding`
 * - Client-only layers clear the configured runner address, so they can send
 *   cluster messages but do not register as shard-owning runners
 *
 * @since 4.0.0
 */
export * as RunnerServer from "./RunnerServer.ts"

/**
 * The `RunnerStorage` module defines the persistence boundary used by clustered
 * runners to register themselves and coordinate shard ownership.
 *
 * Implementations keep track of runner metadata, health, machine ids, and shard
 * locks so a cluster can rebalance work as runners join, leave, or lose their
 * leases. Production adapters usually implement the string-encoded interface and
 * adapt it with {@link makeEncoded}; tests and local setups can use
 * {@link makeMemory}.
 *
 * **Common tasks**
 *
 * - Register and unregister runners in a shared store
 * - Read runner health for scheduling and rebalancing decisions
 * - Acquire, refresh, and release shard locks for distributed processing
 * - Bridge typed cluster values to string or numeric database representations
 *
 * **Gotchas**
 *
 * - Shard acquisition may be partial; callers must use the returned shard list
 * - Refreshing leases is part of keeping shard ownership during rebalancing
 * - The in-memory implementation is process-local and does not persist runner
 *   registrations or locks across restarts
 *
 * @since 4.0.0
 */
export * as RunnerStorage from "./RunnerStorage.ts"

/**
 * The `ShardId` module models the address of a shard inside an Effect Cluster
 * shard group. A shard id is made from a string `group` and numeric `id`, and
 * the module gives that pair stable equality, hashing, primary-key behavior,
 * schema support, and conversion to and from the `group:id` string form used by
 * routing and storage boundaries.
 *
 * **Common tasks**
 *
 * - Create or reuse a cached shard identifier with {@link make}
 * - Check runtime values with {@link isShardId}
 * - Encode or decode shard identifiers with {@link ShardId}
 * - Format for logs, persistence, or transport with {@link toString}
 * - Parse encoded shard keys with {@link fromString} or {@link fromStringEncoded}
 *
 * **Gotchas**
 *
 * - Equality and hashing are based on the `group:id` representation, so both
 *   fields must match for two shard ids to be equal
 * - Encoded strings are split at the last `:`; groups may contain colons, but
 *   ids must parse as numbers
 * - This module identifies shards after a routing or hashing decision; it does
 *   not choose a shard for an arbitrary entity key
 *
 * @since 4.0.0
 */
export * as ShardId from "./ShardId.ts"

/**
 * The `Sharding` module coordinates cluster-wide placement and delivery for
 * entities and singletons. It hashes entity ids into shard ids, tracks which
 * runner owns each shard, acquires local shard locks, and routes RPC messages
 * to the runner that is responsible for the addressed entity.
 *
 * Use this module when building clustered services that need location
 * transparency for stateful entities, singleton workloads that should run once
 * per shard group, or durable message processing backed by cluster storage.
 * Registered entity handlers are started on demand for shards owned by the
 * current runner, while clients produced by the {@link Sharding} service route
 * requests through the sharding service instead of calling handlers directly.
 *
 * **Gotchas**
 *
 * - Shard assignment and shard acquisition are distinct: a runner may be
 *   assigned a shard before it has acquired the storage lock for that shard.
 * - Routing depends on the entity shard group and the configured shard count,
 *   so changing either value affects where entity ids are placed.
 * - Persisted messages are only read and dispatched for shards currently owned
 *   by the local runner; shutdown and runner health changes can temporarily
 *   move work between runners.
 *
 * @since 4.0.0
 */
export * as Sharding from "./Sharding.ts"

/**
 * The `ShardingConfig` module defines the configuration used by a cluster
 * runner to participate in Effect Cluster sharding. It describes how a runner is
 * addressed by other runners, which shard groups it can host, how many shards
 * are assigned per group, and the timing settings used for locks, assignment
 * refreshes, health checks, entity lifecycle, and message polling.
 *
 * Use this module when wiring a sharded application locally with
 * {@link layer}, loading deployment settings from environment variables with
 * {@link layerFromEnv}, or overriding selected defaults for tests and
 * single-node development. In production, keep cluster-wide values such as
 * `shardsPerGroup` and shard groups consistent across runners, choose stable
 * externally reachable runner addresses, and tune lock expiration and refresh
 * intervals to match the storage backend and shutdown behavior of the
 * deployment platform.
 *
 * @since 4.0.0
 */
export * as ShardingConfig from "./ShardingConfig.ts"

/**
 * The `ShardingRegistrationEvent` module defines the events emitted by
 * `Sharding` when the local runner registers entity handlers or singleton
 * workloads. These events are useful for observing the set of capabilities a
 * runner has made available, coordinating startup hooks, and writing tests or
 * integrations that need to react when registrations are complete.
 *
 * Registration events describe local registration, not shard ownership or
 * execution. A runner may register an entity or singleton before it owns the
 * shard that will run it, and the events are in-memory notifications from the
 * `Sharding` service rather than persisted cluster state. For persisted
 * messages, treat registration as the point where the handler is available to
 * the runner; it does not imply that existing storage work has already been
 * read or processed.
 *
 * @since 4.0.0
 */
export * as ShardingRegistrationEvent from "./ShardingRegistrationEvent.ts"

/**
 * The `SingleRunner` module provides a ready-to-use layer for running the
 * cluster sharding services in a single process. It wires together sharding,
 * message storage, runner registration, runner health, and sharding
 * configuration so durable entities and workflows can run without a fleet of
 * external runners.
 *
 * **Common tasks**
 *
 * - Start a local or embedded cluster runner backed by SQL message storage
 * - Run durable entities and workflows in development, tests, or small
 *   single-node deployments
 * - Choose SQL runner storage for persistence or in-memory runner storage for
 *   short-lived scenarios
 * - Override sharding configuration while still using the standard
 *   environment-based defaults
 *
 * **Gotchas**
 *
 * - The layer still requires a `SqlClient` because message storage is SQL-backed
 * - Runner health and runner coordination are no-op implementations, so this is
 *   for single-node use rather than multi-runner cluster coordination
 *
 * @since 4.0.0
 */
export * as SingleRunner from "./SingleRunner.ts"

/**
 * The `Singleton` module provides a small helper for registering effects that
 * should run once across an Effect cluster. A singleton is coordinated through
 * `Sharding`, which assigns ownership to one node at a time and can move that
 * ownership when nodes leave or fail.
 *
 * Use singletons for cluster-wide background work such as schedulers, polling
 * loops, maintenance jobs, or consumers that must not have one instance per
 * process. Because ownership can change during failover, the registered effect
 * should be interruptible, scoped, and able to resume work without assuming that
 * the previous owner completed every in-flight action exactly once.
 *
 * @since 4.0.0
 */
export * as Singleton from "./Singleton.ts"

/**
 * The `SingletonAddress` module defines the address used by cluster sharding to
 * identify a registered singleton. A singleton address combines the singleton
 * name with the `ShardId` that owns it, giving the runtime a stable key for
 * registration events, equality checks, hashing, and runner-local fiber
 * tracking.
 *
 * Use this module when observing singleton registrations or working with
 * sharding internals that need to tell which shard currently owns a singleton.
 * The shard id is derived from the singleton name and shard group at
 * registration time, so changing either value changes ownership and routing.
 * Ownership can also move as shard locks are acquired or released, so an address
 * identifies the target shard rather than guaranteeing that a particular runner
 * is currently executing the singleton.
 *
 * @since 4.0.0
 */
export * as SingletonAddress from "./SingletonAddress.ts"

/**
 * The `Snowflake` module provides compact, sortable identifiers for cluster
 * resources and events. A snowflake id is a branded `bigint` made from a
 * millisecond timestamp, a machine id, and a per-machine sequence number.
 *
 * **Common use cases**
 *
 * - Creating ids without coordinating through a central database
 * - Ordering cluster events, entity ids, or log records by generation time
 * - Encoding ids as strings at service boundaries with {@link SnowflakeFromString}
 * - Decoding a generated id into timestamp, machine id, and sequence parts with {@link toParts}
 *
 * **Gotchas**
 *
 * - Uniqueness depends on each concurrent generator using a distinct machine id
 * - Generated ids are time-sortable, but they are not random or secret values
 * - The default generator prevents local clock drift from moving ids backward
 * - More than 4096 ids in the same millisecond advance the logical timestamp
 *
 * @since 4.0.0
 */
export * as Snowflake from "./Snowflake.ts"

/**
 * The `SocketRunner` module wires cluster runner RPCs to socket transports. It
 * provides a complete runner layer that serves RPC handlers on a `SocketServer`
 * and installs `Sharding` and `Runners` clients for talking to other runners
 * through the socket RPC protocol.
 *
 * **Common tasks**
 *
 * - Run a cluster worker over TCP or Unix sockets with {@link layer}
 * - Connect to other runners while exposing `Sharding` and `Runners` clients
 * - Embed a client-only cluster participant with {@link layerClientOnly} when
 *   the process should send messages but not receive shard assignments
 *
 * **Transport gotchas**
 *
 * - The server listen address comes from the provided `SocketServer` and is
 *   logged when {@link layer} starts
 * - TCP addresses are logged as `hostname:port`, while Unix socket addresses
 *   are logged as their filesystem path
 * - The client-only layer does not start a socket server; provide the full
 *   layer when the process must accept runner RPCs
 *
 * @since 4.0.0
 */
export * as SocketRunner from "./SocketRunner.ts"

/**
 * SQL-backed message storage for the unstable cluster runtime.
 *
 * This module persists encoded cluster envelopes and replies in SQL tables so
 * shards can resume work after process restarts, redeliver unprocessed messages,
 * deduplicate requests by primary key, and replay outstanding reply chunks until
 * they are acknowledged. It is the storage implementation to use when a cluster
 * needs durable request / reply state backed by `SqlClient` rather than an
 * in-memory store.
 *
 * The storage layer runs its own migrations and creates messages, replies, and
 * migration tables using the configured prefix (`cluster` by default). Choose a
 * stable prefix before deploying, because changing it points the runtime at a
 * different set of tables. Existing deployments should also keep the generated
 * migration history table with the message tables so future schema changes can
 * be applied consistently across supported SQL dialects.
 *
 * @since 4.0.0
 */
export * as SqlMessageStorage from "./SqlMessageStorage.ts"

/**
 * SQL-backed storage for Effect Cluster runner metadata and shard ownership.
 *
 * The `SqlRunnerStorage` module builds a `RunnerStorage` implementation from a
 * `SqlClient`, creating the runner and lock tables it needs using the configured
 * table prefix. It is used by clustered applications that need runner
 * registration, health tracking, shard acquisition, refresh, and release to be
 * coordinated through an external database instead of in-memory state.
 *
 * **Common tasks**
 *
 * - Provide the default storage layer with {@link layer}
 * - Use {@link layerWith} when multiple clusters share the same database and
 *   need distinct table prefixes
 * - Create a storage implementation directly with {@link make} for custom layer
 *   composition
 *
 * **Gotchas**
 *
 * - Runner heartbeats and persisted shard locks expire according to
 *   `ShardingConfig.shardLockExpiration`; stale rows may be reused or cleaned up
 *   by later storage operations.
 * - PostgreSQL and MySQL use advisory locks by default, keeping shard ownership
 *   tied to a reserved database connection. Set
 *   `ShardingConfig.shardLockDisableAdvisory` when persisted lock rows should be
 *   used instead.
 * - The selected table prefix controls the generated `runners` and `locks`
 *   table names, so changing it points the cluster at a different storage
 *   namespace.
 *
 * @since 4.0.0
 */
export * as SqlRunnerStorage from "./SqlRunnerStorage.ts"

/**
 * The `TestRunner` module provides a lightweight in-memory cluster layer for
 * tests that need the cluster sharding services without starting real runners
 * or relying on external storage.
 *
 * Use it when exercising sharding behavior, message storage, or code that
 * depends on the cluster runner services in unit and integration tests. The
 * layer wires the normal sharding service to in-memory message and runner
 * storage, along with no-op runner and health implementations.
 *
 * **Testing gotchas**
 *
 * - State is held in memory and scoped to the layer lifetime; it is not shared
 *   across independently constructed layers or persisted between test runs
 * - Runner execution and health checks are no-ops, so this layer is best suited
 *   for testing coordination and storage behavior rather than real distributed
 *   runner processes
 *
 * @since 4.0.0
 */
export * as TestRunner from "./TestRunner.ts"
