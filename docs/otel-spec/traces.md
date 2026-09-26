# Tracing (API & SDK)

This page documents the OpenTelemetry **Tracing** specification: the Trace API (`TracerProvider`,
`Tracer`, `Span`, `SpanContext`), the Trace SDK (samplers, span processors, span limits, ID
generators, the `SpanExporter` interface), and the normative rules a spec-compliant tracing
implementation (or a backend that consumes its output) must honor. Every claim is sourced from the
official specification via inline `Source:` links. Each section states the stability level the spec
itself declares (Stable / Development / Deprecated). Normative strength differs by level: only
Stable sections are locked against breaking change.

## Relevance to Maple

> Maple is mainly a **consumer/backend** of OTel trace data (Rust `apps/ingest` OTLP gateway →
> collector → ClickHouse/Tinybird → web dashboard). It is also a **self-instrumented emitter** of its
> own traces: `@maple-dev/effect-sdk` (`packages/effect-sdk`) in the api, ai and alerting workers,
> and `apps/ingest`'s own Rust OTLP self-instrumentation (`apps/ingest/src/otel.rs`,
> `service.name = "ingest"`). Both angles make this spec matter.
>
> - **As a consumer/backend:** we must defensively parse whatever a compliant (or non-compliant)
>   SDK emits. Invariants to enforce or tolerate:
>     - `TraceId`/`SpanId` validity: all-zero is invalid (§[SpanContext](#spancontext)).
>     - `Sampled=true, IsRecording=false` is spec-forbidden and should never reach us
>       (§[Sampling](#sampling-sdk)).
>     - `StatusCode` ordering is `Ok > Error > Unset`, and `Description` only has meaning on
>       `Error` (§[Status](#set-status)).
>     - The 5 `SpanKind` values drive our service-map/flamegraph parent-child inference
>       (§[SpanKind](#spankind)).
>
>   Maple stores span status as title-case `"Ok"`/`"Error"`/`"Unset"` strings (CLAUDE.md,
>   "Span status codes"). That matches the spec's enum spelling. The OTLP wire encoding uses a
>   different uppercase enum (`STATUS_CODE_OK` / `STATUS_CODE_ERROR` / `STATUS_CODE_UNSET`); the
>   ingest/collector mapping layer is the one place that translation must stay correct.
> - **As a self-instrumented emitter:** our own services configure `BatchSpanProcessor` knobs,
>   samplers (`OTEL_TRACES_SAMPLER` / `_ARG`), and span limits via the env vars in
>   §[Span Limits](#span-limits) and §[Span Processor](#span-processor-sdk). The
>   `HttpMiddleware.TracerDisabledWhen` health-check filter (`apps/api/src/http/api-observability.ts`)
>   and the `workerd` monotonic-clock timestamp bug both require precise reasoning about `Span`
>   start/end timestamp semantics (§[Span](#span)) and `OnStart`/`OnEnd` processor timing
>   (§[Span Processor](#span-processor-sdk)).
> - **Links added after span start** (§[Add Link](#add-link)) and **attributes preferred at
>   creation** (§[Span Creation](#span-creation)) matter when reviewing our own instrumentation.
>   Sampling only sees what was present at span start.

---

## 1. Scope and stability

**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/ ,
https://opentelemetry.io/docs/specs/otel/trace/sdk/

Both the Trace API spec and the Trace SDK spec carry the document-level banner:

> "**Status**: Stable, except where otherwise specified"

Unless a subsection is explicitly marked otherwise, treat it as **Stable** (locked against breaking
changes). Several subsections, mostly newer extension points, are marked **Development**
(pre-release, can still change) inline; this doc calls them out. `TraceIdRatioBased`'s
_configuration/creation_ API is Stable, but its _algorithm_ compatibility is flagged separately
(see §[Samplers](#samplers)). No section in either document is marked **Experimental** or
**Deprecated** at time of writing (2026). `TraceIdRatioBased` is, however, textually described as
"deprecated in favor of" `ProbabilitySampler` (a **Development** component); see
§[Samplers](#samplers) for the exact deprecation timeline.

---

## 2. SpanContext

**Stability: Stable.**
**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#spancontext

A `SpanContext` is the serializable portion of a `Span`: the part that must be propagated across
process boundaries. `SpanContext`s are **immutable**. The representation conforms to the
[W3C TraceContext spec](https://www.w3.org/TR/trace-context/).

| Field        | Rule                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TraceId`    | 16-byte array; **valid** iff it has at least one non-zero byte (all-zero = invalid)                                                                                                                                                                                          |
| `SpanId`     | 8-byte array; **valid** iff it has at least one non-zero byte (all-zero = invalid)                                                                                                                                                                                           |
| `TraceFlags` | Present on every span context (unlike `TraceState`). Currently defines two flags: `Sampled` ([W3C sampled flag](https://www.w3.org/TR/trace-context-2/#sampled-flag)) and `Random` ([W3C random-trace-id flag](https://www.w3.org/TR/trace-context-2/#random-trace-id-flag)) |
| `TraceState` | List of tracing-system-specific key-value pairs; lets multiple tracing systems co-participate in one trace; fully defined by [W3C `tracestate`](https://www.w3.org/TR/trace-context-2/#tracestate-header)                                                                    |
| `IsRemote`   | Boolean: was this `SpanContext` received from another process, or generated locally?                                                                                                                                                                                         |

Normative rules:

- The API **MUST** implement methods to create a `SpanContext`, and these **SHOULD** be the only
  way to create one. This functionality "MUST be fully implemented in the API, and SHOULD NOT be
  overridable."
- **Retrieving TraceId/SpanId:** the API **MUST** allow retrieval in hex (32-char lowercase hex
  string for `TraceId`, 16-char for `SpanId`) and binary (16-byte / 8-byte array) forms. The API
  **SHOULD NOT** expose how they are stored internally.
- **`IsValid`**: "MUST be provided." Returns `true` iff both `TraceId` and `SpanId` are non-zero.
- **`IsRemote`**: "MUST be provided." When a `SpanContext` is extracted via the Propagators API,
  `IsRemote` **MUST** return `true`. For any child span's own context it **MUST** return `false`.
- **`TraceState` operations:** the API **MUST** provide get value for key, add key-value pair,
  update existing value, and delete pair. All mutating operations **MUST** return a new immutable
  `TraceState`. All must validate their inputs and **MUST NOT** return a `TraceState` containing
  invalid data on invalid input (follow the "general error handling guidelines" instead). Because
  `SpanContext` is immutable, a new `TraceState` can only take effect at
  [propagation](https://opentelemetry.io/docs/specs/otel/context/api-propagators/) or
  [export](https://opentelemetry.io/docs/specs/otel/trace/sdk/#span-exporter) time. Propagators
  and exporters may create a modified copy right before serializing to the wire.

---

## 3. Span

**Stability: Stable** (see §[Span Creation](#span-creation) for one Development-status nuance
inherited from the SDK's `TracerConfig`).
**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#span

A `Span` represents a single operation within a trace. Spans nest into a trace tree with one root
span per trace. A `Span` encapsulates: name, an immutable `SpanContext`, a parent (`Span` /
`SpanContext` / null), `SpanKind`, start/end timestamps, `Attributes`, a list of `Link`s, a list of
timestamped `Event`s, and a `Status`.

**Span name:** "the most general string that identifies a (statistically) interesting _class of
Spans_" rather than a per-instance identifier. Generality wins over human readability. Example:
`get_account` is good; `get_account/42` is not (cardinality); `get_account/{accountId}` is
acceptable (HTTP-route form).

**Timestamps:** "A `Span`'s start and end timestamps reflect the elapsed real time of the
operation." Start time **SHOULD** default to span-creation time. After creation it **SHOULD** be
possible to change the name, set attributes, add events, and set status. None of these **MUST** be
changed after the end timestamp has been set.

**Isolation from application logic:** spans are not meant to propagate information within a
process. Implementations **SHOULD NOT** expose a `Span`'s own attributes/events back to the user;
only its `SpanContext` is retrievable. Vendors may implement `Span` for vendor-specific logic, but
alternative implementations **MUST NOT** allow callers to create `Span`s directly. All `Span`s
**MUST** be created via a `Tracer`.

### Span Creation

**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#span-creation

- There **MUST NOT** be any API for creating a `Span` other than via a `Tracer`.
- In languages with implicit context propagation, span creation **MUST NOT** set the new span as
  the active span in the current `Context` by default (this MAY be offered as a separate operation).
- Required/accepted parameters:
    - **Name**: required.
    - **Parent `Context`** or an explicit "root span" indication. The API **MUST NOT** accept a
      `Span` or `SpanContext` directly as parent, only a full `Context`. (See
      [Determining the Parent Span from a Context](#determining-the-parent-span-from-a-context).)
    - **`SpanKind`**: defaults to `SpanKind.Internal` if unspecified.
    - **`Attributes`**: an empty collection is assumed if not given. "The API documentation MUST
      state that adding attributes at span creation is preferred to calling `SetAttribute` later, as
      samplers can only consider information already present during span creation."
    - **`Link`s**: an ordered sequence, see §[Link](#link).
    - **Start timestamp**: defaults to current time. It "SHOULD only be set when span creation time
      has already passed" (don't pass "now" explicitly).
- Root spans: "Implementations MUST provide an option to create a `Span` as a root span, and MUST
  generate a new `TraceId` for each root span created." For a non-root span, `TraceId` **MUST**
  match the parent's, and the child **MUST** inherit all of the parent's `TraceState` values by
  default.
- A `Span` has a **remote parent** if it is a child of a span created in another process. Each
  propagator's deserialization must set `IsRemote=true` on that parent `SpanContext`.
- "Any span that is created MUST also be ended. This is the responsibility of the user." Failing
  to end a span MAY leak memory/resources in the implementation.

#### Determining the Parent Span from a Context

If the input `Context` contains a `Span`, that is the parent. If not, the new span is a root span.
A bare `SpanContext` cannot be set active in a `Context` directly. It must first be
[wrapped in a (non-recording) Span](#wrapping-a-spancontext-in-a-span).

#### Specifying links

"During Span creation, a user MUST have the ability to record links to other Spans" (same or
different trace). "Links added at Span creation may be considered by Samplers to make a sampling
decision." Links added later lack this (see §[Add Link](#add-link)).

### Span operations

**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#span-operations

"With the exception of the function to retrieve the Span's SpanContext and `IsRecording`, none of
the below may be called after the Span is finished."

| Operation            | Key normative rule                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Get Context**      | MUST return the `SpanContext`; usable even after the span ends; MUST be the same value for the entire span lifetime. MAY be called `GetContext`.                                                                                                                                                                          |
| **IsRecording**      | See dedicated subsection below.                                                                                                                                                                                                                                                                                           |
| **Set Attributes**   | MUST provide a single-attribute setter (`SetAttribute`); MAY provide a batch setter. Duplicate keys overwrite. Samplers only see attributes present at creation time; later changes can't affect their decision.                                                                                                          |
| **Add Events**       | MUST provide `AddEvent(name, attributes?, timestamp?)`; timestamp defaults to call time if omitted. Events SHOULD preserve recording order (may differ from timestamp order if custom timestamps are used out of order). An event's timestamp may legally fall before span start or after span end; no normalization is required. |
| **Add Link**         | MUST support adding links post-creation (see §[Add Link](#add-link)), but these "may not be considered by Samplers."                                                                                                                                                                                                     |
| **Set Status**       | See §[Set Status](#set-status).                                                                                                                                                                                                                                                                                           |
| **UpdateName**       | Changes span name post-creation. Sampling behavior afterwards is implementation-defined, since samplers can't retroactively reconsider.                                                                                                                                                                                   |
| **End**              | See dedicated subsection below.                                                                                                                                                                                                                                                                                           |
| **Record Exception** | Language-specific specialization of `AddEvent` for exceptions (see below).                                                                                                                                                                                                                                                |

#### IsRecording

"A `Span` is recording (`IsRecording` returns `true`) when the data provided to it via functions
like `SetAttributes`, `AddEvent`, `SetStatus` is captured in some form (e.g. in memory). When a
`Span` is not recording ... all this data is discarded right away." Further calls become no-ops.

**"This flag may be `true` despite the entire trace not being sampled."** A system can record and
process all spans locally (e.g. for SLA/SLO latency charts) while exporting only a sampled subset
to the backend. See §[Sampling](#sampling-sdk) for the full `IsRecording` × `Sampled` matrix.

"After a `Span` is ended, it SHOULD become non-recording and `IsRecording` SHOULD always return
`false`." Streaming implementations without local state are the one documented exception.
`IsRecording` **SHOULD NOT** take parameters and **SHOULD** be used to skip expensive attribute/event
computation when a span isn't recording. A child span's recording state is independent of its
parent's `IsRecording` value; the `Sampled` flag on `SpanContext` drives it instead. "Users of the
API should only access the `IsRecording` property when instrumenting code and never access
`SampledFlag` unless used in context propagators."

#### Set Status

**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#set-status

Overrides the default `Unset` status. `Status` = `{ StatusCode, Description? }`.
`Description` **MUST** only be used with `StatusCode=Error` (an empty description is treated as
absent). It **MUST be ignored** for `Ok`/`Unset`.

| `StatusCode` | Meaning                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `Unset`      | The default status.                                                                                        |
| `Ok`         | "The operation has been validated by an Application developer or Operator to have completed successfully." |
| `Error`      | The operation contains an error.                                                                           |

These "form a total order: `Ok > Error > Unset`". Setting `Ok` overrides any prior _or future_
attempt to set `Error`/`Unset`. Additional rules:

- An attempt to set `Unset` explicitly **SHOULD** be ignored.
- When instrumentation libraries set `Error`, the `Description` **SHOULD** be documented and
  predictable. The decision to set `Error` at all **should only follow semantic-convention rules**
  (or the library's own published conventions if none exist for that operation).
- "Generally, Instrumentation Libraries SHOULD NOT set the status code to `Ok`, unless explicitly
  configured to do so." They **SHOULD** leave status `Unset` absent an error.
- Only **application developers and operators** (end-user code, not instrumentation libraries) are
  expected to set `Ok`.
- Once `Ok` is set it **SHOULD** be considered final; further changes **SHOULD** be ignored.
- "Analysis tools SHOULD respond to an `Ok` status by suppressing any errors they would otherwise
  generate" (e.g. suppressing a noisy 404-as-error).
- "Only the value of the last call will be recorded." Implementations are free to ignore earlier
  `SetStatus` calls when a later, permitted one arrives.

> **Maple note:** the spec's enum spelling (`Unset`/`Ok`/`Error`) is exactly the title-case string
> Maple stores (CLAUDE.md, "Span status codes"). The OTLP wire proto uses a different, uppercase,
> prefixed spelling: `STATUS_CODE_UNSET` / `STATUS_CODE_OK` / `STATUS_CODE_ERROR` (see the
> [OTLP trace.proto `Status.StatusCode`](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto)).
> The API spec notes that the OTLP proto calls `Description` `message`. Ingest mapping code that
> translates OTLP to Maple's internal representation is where this spelling difference must be
> handled, once and consistently.

#### End

"Signals that the operation described by this span has now (or at the time optionally specified)
ended." Implementations **SHOULD** ignore subsequent calls to `End` or any other span method; the
span becomes non-recording once ended (streaming exceptions noted above). Other end-triggering
language sugar (e.g. Python `with`) **MUST** internally call `End` and be documented as such.

- **`End` MUST NOT affect child spans.** They may still be running and end later independently.
- **`End` MUST NOT inactivate the span in any `Context`** it is active in. An ended span remains
  usable as a parent via that context, and any Context-attachment mechanism must keep working.
- Optional parameter: explicit end timestamp. If omitted, "now" is used.
- Performance: "Expect this operation to be called in the hot path of production applications. It
  needs to be designed to complete fast, if not immediately." `End` itself **MUST NOT** perform
  blocking I/O on the calling thread, and locking should be minimized where possible.
  Test/debug-only processors and exporters are explicitly out of scope for this requirement.

#### Record Exception

Languages that use exceptions **SHOULD** provide `RecordException` as a specialized `AddEvent`. The
same requirements as `AddEvent` apply except where overridden here. The minimum required argument
**SHOULD** be just the exception object. If the method exists, it **MUST** accept an optional
parameter for additional attributes; existing conventional attributes take precedence over
duplicates supplied this way.

### Span lifetime

"Start and end time as well as Event's timestamps MUST be recorded at [the] time of ... calling of
[the] corresponding API." Timestamps reflect the moment the API call happens (or an explicit
override), not some other clock.

### Wrapping a SpanContext in a Span

The API **MUST** provide an operation that wraps a bare `SpanContext` as a `Span` (for in-process
propagation, e.g. propagator extraction). If a new type is needed for this, it **SHOULD NOT** be
publicly exposed if avoidable. If it must be, it **SHOULD** be named `NonRecordingSpan`. Behavior:

- `GetContext` **MUST** return the wrapped `SpanContext`.
- `IsRecording` **MUST** return `false`.
- All remaining `Span` methods **MUST** be no-ops, including `End`. This is the one exception to
  "every span must be ended": ending a wrapped context is neither required nor useful.

This "MUST be fully implemented in the API, and SHOULD NOT be overridable."

---

## 4. SpanKind

**Stability: Stable.**
**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#spankind

`SpanKind` communicates two independent properties for analysis tooling: (1) outgoing remote call
vs. incoming external request, and (2) request/response vs. deferred execution. "In order for
`SpanKind` to be meaningful, callers SHOULD arrange that a single Span does not serve more than one
purpose." For example, a server-handling span should not double as the span for an outgoing RPC it
makes; instrumentation should start a _new_ span before injecting `SpanContext` for an outgoing call.

| `SpanKind` | Call direction | Communication style | Definition                                                                                                                                                                                       |
| ---------- | -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SERVER`   | incoming       | request/response    | Covers server-side handling of a remote request while the client awaits a response.                                                                                                              |
| `CLIENT`   | outgoing       | request/response    | Describes a request to a remote service where the client awaits a response. When propagated, a `CLIENT` span usually becomes the parent of a remote `SERVER` span.                               |
| `PRODUCER` | outgoing       | deferred execution  | Initiation/scheduling of a local or remote operation; often ends before the correlated `CONSUMER` span even starts. In batched messaging, each individual message needs its own `PRODUCER` span. |
| `CONSUMER` | incoming       | deferred execution  | Processing of an operation initiated by a producer that does not wait for the outcome.                                                                                                           |
| `INTERNAL` | (n/a)          | (n/a)               | **Default value.** An internal operation, as opposed to one with remote parents/children.                                                                                                        |

Notes: a `CLIENT` span may have a `CLIENT` child, and a `PRODUCER` may have a local `CLIENT` child.
Kind describes the _edge_, not a strict alternating pattern. Technology-specific semantic
conventions document the expected kind per operation type (e.g. DB client calls use `CLIENT`; if a
DB client itself talks HTTP, the nested HTTP instrumentation creates its own nested `CLIENT` spans).

> **Maple relevance:** these 5 kinds (plus `PRODUCER`/`CONSUMER` pairing rules) drive service-map
> edge direction and any parent/child inference Maple's flamegraph or trace-topology code performs.
> A `PRODUCER` span ending before its `CONSUMER` starts is expected, not a data bug.

---

## 5. Link

**Stability: Stable.**
**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#link ,
https://opentelemetry.io/docs/specs/otel/trace/api/#add-link

"A user MUST have the ability to record links to other `SpanContext`s. Linked `SpanContext`s can
be from the same or a different trace." A `Link` = `{ SpanContext, Attributes? }`.

- The API **MUST** provide a single-link recorder (e.g. `AddLink`) taking the target `SpanContext`
  plus optional attributes. It **MAY** provide a batch-add variant.
- "Implementations SHOULD record links containing `SpanContext` with empty `TraceId` or `SpanId`
  (all zeros) as long as either the attribute set or `TraceState` is non-empty." A link can
  legitimately carry an invalid ID pair if it only exists to carry attributes/tracestate.
- Order of links **SHOULD** be preserved as set.
- **Links added at span creation** are preferred and documented as such, "because head sampling
  decisions can only consider information present during span creation."
- **Links added after creation** (`AddLink` post-start) are explicitly allowed: "A `Span` MUST
  have the ability to add `Link`s associated with it after its creation." But "Links added after
  `Span` creation may not be considered by Samplers."

**Concurrency:** Links are immutable and **SHOULD** be safe for concurrent use by default. Events
are immutable and **MUST** be safe for concurrent use, a slightly stronger requirement.

---

## 6. TracerProvider / Tracer

**Stability: Stable** for the core API-level operations described here; **Development** for
`TracerConfigurator`/`TracerConfig` (SDK-level dynamic enable/disable), see
§[TracerProvider / Tracer (SDK)](#tracerprovider--tracer-sdk).
**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#tracerprovider ,
https://opentelemetry.io/docs/specs/otel/trace/api/#tracer

`TracerProvider` is the API's entry point and the stateful object holding configuration. The API
**SHOULD** provide a way to set/register and access a global default instance. Implementations
**SHOULD** allow creating any number of independent `TracerProvider` instances (e.g. for
per-dependency-injection-scope configuration).

**Get a Tracer**: `TracerProvider` **MUST** provide this. Accepted parameters:

| Param        | Required?              | Notes                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | required               | "SHOULD uniquely identify the instrumentation scope" (library/package/module/class name). Invalid (null/empty) input **MUST** still return a working `Tracer`, not null or an exception. Its `name` **SHOULD** keep the original invalid value, and an invalid-input message **SHOULD** be logged. Implementations _may_ ignore `name` entirely if "named" tracers aren't supported. |
| `version`    | optional               | Instrumentation scope version, e.g. `"1.0.0"`.                                                                                                                                                                                                                                                                                         |
| `schema_url` | optional, since 1.4.0  | Schema URL recorded in emitted telemetry.                                                                                                                                                                                                                                                                                              |
| `attributes` | optional, since 1.13.0 | Instrumentation scope attributes to associate with emitted telemetry.                                                                                                                                                                                                                                                                  |

Two `Tracer`s are _identical_ if all params match, and _distinct_ otherwise. "Implementations MUST
NOT require users to repeatedly obtain a `Tracer` again with the same identity to pick up
configuration changes." The old `Tracer` may pick up new config live or keep working with stale
config; either is compliant as long as re-acquisition isn't _required_.

**Tracer operations:** `Tracer` **MUST** provide span creation. It **SHOULD** provide an `Enabled()`
check (see §[Tracer (SDK)](#tracerprovider--tracer-sdk) for the SDK semantics behind its return
value) so callers can skip expensive work when tracing is off. `Enabled`'s return value can change
over time. The API **SHOULD** document that instrumentation must re-check it per span, not cache it.

**Concurrency:** all `TracerProvider`, `Tracer`, and `Span` methods **MUST** be documented as safe
for concurrent use by default.

---

## 7. Context interaction

**Stability: Stable.**
**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#context-interaction

The API **MUST** provide, against the generic
[`Context`](https://opentelemetry.io/docs/specs/otel/context/): (1) extracting the `Span` from a
`Context`, and (2) combining a `Span` with a `Context` to produce a new `Context`. These exist because
API users **SHOULD NOT** have direct access to the Context Key the tracing API uses internally.

If the language supports **implicit** context propagation, the API **SHOULD** also provide:
getting the currently active span (get implicit context, then extract span), and setting the active
span (combine, then make implicit). These may be exposed as static module-level functions and
**SHOULD** be fully implemented at the API layer where possible.

---

## 8. Behavior of the API without an installed SDK

**Stability: Stable.**
**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#behavior-of-the-api-in-the-absence-of-an-installed-sdk

"In general, in the absence of an installed SDK, the Trace API is a no-op API." Operations on a
`Tracer` or `Span` have no side effects. The one carve-out is `SpanContext` propagation continuity:
the API **MUST** return a non-recording `Span` wrapping whatever `SpanContext` was in the parent
`Context` (explicit or current implicit). If that parent context's span is already non-recording,
it **SHOULD** be returned directly (no new object). If the parent context has no span at all, an
**empty** non-recording span **MUST** be returned: all-zero `SpanContext`, empty `TraceState`,
unsampled flags. Net effect: a `SpanContext` supplied by a configured `Propagator` still flows
through to children and eventually `Inject`, but no _new_ `SpanContext` is created without an SDK.

---

## 9. Concurrency requirements (API)

**Source:** https://opentelemetry.io/docs/specs/otel/trace/api/#concurrency-requirements

- **TracerProvider / Tracer / Span:** all methods **MUST** be documented safe for concurrent use
  by default.
- **Event:** immutable, **MUST** be safe for concurrent use by default.
- **Link:** immutable, **SHOULD** be safe for concurrent use by default.

---

## 10. SDK: TracerProvider / Tracer (SDK)

**Stability: mixed.** Core `TracerProvider` responsibilities (owning config, `Shutdown`,
`ForceFlush`) are **Stable**. Per-tracer dynamic enable/disable via `TracerConfigurator` /
`TracerConfig` is explicitly **Development**.
**Source:** https://opentelemetry.io/docs/specs/otel/trace/sdk/#tracer-provider

The SDK's `TracerProvider` **MUST** implement the API's Get-a-Tracer operation and **MUST** build
the `InstrumentationScope` from the caller-supplied name/version/schema_url/attributes, storing it
on the returned `Tracer`. The `TracerProvider` owns configuration: `SpanProcessor`s, `IdGenerator`,
`SpanLimits`, `Sampler`, and (Development) `TracerConfigurator`. Configuration MAY be applied at
construction time and the provider MAY expose update methods, but any update **MUST** apply
retroactively to already-returned `Tracer`s. Implementations typically do this by having `Tracer`s
hold a reference back to the provider rather than caching config.

**Shutdown:** MUST be called only once per `TracerProvider`. `GetTracer` calls after Shutdown are
disallowed; SDKs **SHOULD** return a working no-op `Tracer` if possible instead of erroring.
**MUST** be implemented by invoking `Shutdown` on all internal processors. **SHOULD** report
success/failure/timeout to the caller and **SHOULD** complete or abort within some timeout (sync or
async, implementation's choice).

**ForceFlush:** immediately exports all not-yet-exported spans across all internal processors.
**MUST** invoke `ForceFlush` on every registered `SpanProcessor`. The same SHOULD-report-outcome /
SHOULD-timeout guidance as Shutdown applies.

**`TracerConfigurator` (Development):** a function `tracer_scope -> TracerConfig` (or a
"use-default" sentinel). The `TracerProvider` calls it per `Tracer` at first creation and, if
updating is supported, for every outstanding `Tracer` when the configurator itself is updated. So
"it is important that it returns quickly." It is modeled as a function for flexibility; SDKs MAY
offer shorthand helpers (select tracers by name/pattern, disable specific tracers,
disable-all-then-allowlist).

**`TracerConfig` (Development):** currently one field, `enabled` (default `true`). A disabled
`Tracer` **MUST** behave like the API's no-op/no-SDK `Tracer`. `enabled` directly determines
`Enabled()`'s return value. Config changes need not be _immediately_ visible to `Enabled()`
callers, but they **MUST** be eventually visible.

**`Enabled` (SDK semantics; a Development flag inside a Stable-by-default method):** **MUST** return
`false` when there are no registered `SpanProcessor`s, or (Development) when
`TracerConfig.enabled == false`. Otherwise it **SHOULD** return `true`, and MAY return `false` for
other optimization reasons.

---

## 11. SDK: Additional span interfaces (readable / read-write span)

**Source:** https://opentelemetry.io/docs/specs/otel/trace/sdk/#additional-span-interfaces

The API only defines write access to a `Span`. The SDK needs to read data back out for processors
and exporters, so it defines two SDK-internal contracts:

- **Readable span:** MUST expose everything added via the API-level `Span` interface (that spec
  section is authoritative for the full list). MUST expose `InstrumentationScope` (since 1.10.0)
  and `Resource`. MUST, for back-compat, also expose the deprecated `InstrumentationLibrary` view
  with matching name/version. MUST let callers reliably determine whether the span has ended. MUST
  expose attribute/event/link **dropped counts** (for exporters, per the
  [non-OTLP mapping spec](https://opentelemetry.io/docs/specs/otel/common/mapping-to-non-otlp/#dropped-attributes-count)).
  Implementations MAY choose not to expose the full parent `Context`, but MUST expose at least the
  full parent `SpanContext`. May or may not be mutable.
- **Read/write span:** everything a readable span has, plus the full write API. Callers **MUST** be
  able to obtain the _same_ `Span` instance/type that span creation returned to the user (e.g.
  passed as a parameter, or via a getter).

---

## 12. Sampling (SDK) {#sampling-sdk}

**Stability: mixed.** The core `Sampler`/`ShouldSample` contract, `AlwaysOn`/`AlwaysOff`, and
`TraceIdRatioBased`'s _configuration/creation_ surface are **Stable**. `ProbabilitySampler`,
`CompositeSampler`/`ComposableSampler`, and the whole explicit-randomness / `Random`-flag apparatus
are **Development**. `TraceIdRatioBased`'s _algorithm compatibility_ note is separately flagged
**Development** even though the sampler itself is Stable.
**Source:** https://opentelemetry.io/docs/specs/otel/trace/sdk/#sampling

Sampling controls collection noise and overhead. Two API-level signals govern it:

- **`IsRecording`** on `Span`: if `false`, all data is discarded. `SpanProcessor`s **MUST** only
  receive spans with `IsRecording == true`. `SpanExporter`s **SHOULD NOT** receive them unless
  `Sampled` is _also_ set.
- **`Sampled`** flag in `TraceFlags` on `SpanContext`: propagates to children via `SpanContext` and
  indicates the span _has been_ sampled and will be exported. Exporters **MUST** receive spans with
  `Sampled == true` and **SHOULD NOT** receive ones without it.

### Recording × Sampled reaction table

| `IsRecording` | `Sampled` | Processor receives? | Exporter receives? |
| ------------- | --------- | ------------------- | ------------------ |
| true          | true      | true                | true               |
| true          | false     | true                | false              |
| false         | true      | **Not allowed**     | **Not allowed**    |
| false         | false     | false               | false              |

`IsRecording=false, Sampled=true` is forbidden: "the OpenTelemetry SDK MUST NOT allow this
combination" because it would create gaps in the distributed trace. `IsRecording=true,
Sampled=false` is legal and means "this span records data but its children likely won't."

> **Maple relevance:** a spec-compliant SDK never emits the forbidden combination. Defensive
> ingest code should still treat `Sampled=true` with missing span data as a sign of a
> non-compliant producer or transport-layer data loss, not assume it can't happen.

### SDK span creation order

When creating a span, the SDK **MUST** act as if it does the following, in order:

1. Use the parent's trace ID if valid, else generate a new one. This happens _before_ calling
   `ShouldSample`, which requires a valid trace ID as input.
2. Call the `Sampler`'s `ShouldSample`.
3. Generate a new span ID regardless of the sampling decision, so other components (logs,
   exception handling) can rely on a unique span ID even for a non-recording span.
4. Construct the span per the `ShouldSample` decision. A non-recording result MAY reuse the same
   "wrap a SpanContext" mechanism as the no-SDK API path.

### Sampler interface

**`ShouldSample`** required inputs: parent `Context` (its `SpanContext` may be invalid, meaning a
root span), the new span's `TraceId` (MUST match the parent's if the parent has a valid trace ID),
span name, `SpanKind`, initial `Attributes`, and the collection of `Link`s. Returns a
`SamplingResult`:

| `SamplingResult` field | Meaning                                                                                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Decision`             | One of `DROP` / `RECORD_ONLY` / `RECORD_AND_SAMPLE`; see table below.                                                                                                                                                   |
| Attributes             | Additional span attributes to add; the returned object MUST be immutable.                                                                                                                                               |
| `Tracestate`           | The `TraceState` for the new `SpanContext`. If the sampler returns an _empty_ `Tracestate`, the existing one is cleared, so samplers that don't intend to change it SHOULD pass through the incoming value unmodified. |

| `Decision`          | `IsRecording`                                                | `Sampled` flag      |
| ------------------- | ------------------------------------------------------------ | ------------------- |
| `DROP`              | `false`: span not recorded, all events/attributes dropped    | not set             |
| `RECORD_ONLY`       | `true`                                                       | **MUST NOT** be set |
| `RECORD_AND_SAMPLE` | `true`                                                       | **MUST** be set     |

**`GetDescription`** returns the sampler's name/config as a debug string (e.g.
`"TraceIdRatioBased{0.000100}"`). It MAY change over time (e.g. under dynamic reconfiguration);
callers **SHOULD NOT** cache it.

### Built-in samplers

**Default sampler: `ParentBased(root=AlwaysOn)`.**

| Sampler                                  | Status                                                                      | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AlwaysOn`                               | Stable                                                                      | Always returns `RECORD_AND_SAMPLE`. Description MUST be `AlwaysOnSampler`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `AlwaysOff`                              | Stable                                                                      | Always returns `DROP`. Description MUST be `AlwaysOffSampler`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `TraceIdRatioBased`                      | Stable (config/creation API); algorithm compatibility notes are Development | A deterministic hash of `TraceId` decides sampling. Ignores the parent `Sampled` flag (compose with `ParentBased` to respect it). A given ratio MUST sample a superset of what any lower-ratio instance would sample (monotonic, so a backend can safely sample at a higher rate than the frontend). **Deprecation note:** being phased out in favor of `ProbabilitySampler`. "OpenTelemetry SDK implementors SHALL NOT remove or modify the behavior of the original `TraceIdRatioBased` sampler until at least January 1, 2027"; after that, they are encouraged to silently swap in an equally configured `ProbabilitySampler`. The exact hash algorithm was never specified, so results may differ across SDKs and versions; it is recommended only as a _root_ sampler. |
| `ProbabilitySampler`                     | Development                                                                 | Ratio sampler built on W3C Trace Context Level 2's 56 bits of randomness (see [Probability Sampling in TraceState](https://opentelemetry.io/docs/specs/otel/trace/tracestate-probability-sampling/)). Ignores the parent `Sampled` flag (compose with `ParentBased`). Configured with a ratio in `[2^-56, 1.0]`. On `ShouldSample`, compares randomness value `R` against rejection threshold `T` derived from the ratio: `R >= T` ⇒ `RECORD_AND_SAMPLE` and sets `ot=th:T` in tracestate; otherwise `DROP`.                                                                                                                                                                                                                                  |
| `ParentBased`                            | Stable                                                                      | Decorator dispatching on parent shape; see table below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `JaegerRemoteSampler`                    | Stable                                                                      | Periodically pulls sampling config from a remote endpoint (Jaeger Collector or OTel Collector implementing the [Remote Sampling API](https://www.jaegertracing.io/docs/2.14/architecture/apis/#remote-sampling-configuration)). Can assign different strategies per span name (e.g. `/product` at 10%, `/admin` at 100%, never `/metrics`). Configurable: `endpoint`, `polling interval`, `initial sampler` (used before the first fetch).                                                                                                                                                                                                                                                                                                                 |
| `AlwaysRecord`                           | Stable                                                                      | Decorator: converts a wrapped sampler's `DROP` into `RECORD_ONLY` (all other decisions pass through unchanged), so every span reaches processors (e.g. for span-to-metrics) without necessarily being exported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CompositeSampler` / `ComposableSampler` | Development                                                                 | Implements `Sampler` by delegating to `ComposableSampler.GetSamplingIntent` (threshold + `adjusted_count_reliable` + optional attribute/tracestate providers), then compares a randomness value `R` against the returned threshold to reach the final decision. Built-in composables: `ComposableAlwaysOn`, `ComposableAlwaysOff`, `ComposableProbability` (ratio `[2^-56, 1.0]`), `ComposableParentThreshold` (propagate the parent's decision/threshold), `ComposableRuleBased` (predicate → sampler rule list, first match wins), `ComposableAnnotating` (delegate + extra attributes on sampled spans).                                                                                                                                            |

**`ParentBased` dispatch table.** Required param `root(Sampler)`. Optional params
`remoteParentSampled` (default `AlwaysOn`), `remoteParentNotSampled` (default `AlwaysOff`),
`localParentSampled` (default `AlwaysOn`), `localParentNotSampled` (default `AlwaysOff`):

| Parent  | `IsRemote()` | `IsSampled()` | Delegate invoked           |
| ------- | ------------ | ------------- | -------------------------- |
| absent  | n/a          | n/a           | `root()`                   |
| present | true         | true          | `remoteParentSampled()`    |
| present | true         | false         | `remoteParentNotSampled()` |
| present | false        | true          | `localParentSampled()`     |
| present | false        | false         | `localParentNotSampled()`  |

### Sampling requirements: TraceID randomness (Development)

The [W3C Trace Context Level 2](https://www.w3.org/TR/trace-context-2/) CR defines a `Random` trace
flag meaning "the rightmost 7 bytes / 56 bits of the TraceID are random." SDKs **SHOULD** set this
flag on root spans when the TraceIDs they generate meet that randomness bar. SDKs and samplers
**MUST NOT** overwrite an explicit randomness value (the `rv` sub-key of OTel's `tracestate`, see
[TraceState Handling](https://opentelemetry.io/docs/specs/otel/trace/tracestate-handling/#explicit-randomness-value-rv))
once a user has set one. Root samplers MAY insert an `rv` value themselves when the generated
TraceID doesn't meet the randomness bar and no `rv` is present. Absent an explicit randomness
value, samplers **SHOULD** presume TraceIDs are W3C-Level-2-random. Custom `IdGenerator`s
**SHOULD** self-identify when all their generated TraceIDs meet the randomness bar, so the SDK can
set the `Random` flag correctly.

---

## 13. Span Limits

**Stability: Stable** (attribute-limit portions are defined once, in the common spec, and inherited
here).
**Source:** https://opentelemetry.io/docs/specs/otel/trace/sdk/#span-limits

Span attributes **MUST** follow the common
[attribute-limits](https://opentelemetry.io/docs/specs/otel/common/#attribute-limits) rules. The
SDK MAY also discard links/events beyond a configured per-collection limit. If a limit is
implemented, the SDK **MUST** expose a way to change it via `TracerProvider` configuration.
Discarding an attribute/event/link due to a limit **SHOULD** log a message, and it **MUST** be
logged **at most once per span** (not once per discarded item) to avoid log spam.

| Limit                                | Default  | Env var                                                                                      | Notes                                                                                                                                                                                        |
| ------------------------------------ | -------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AttributeCountLimit` (common)       | 128      | `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT` (falls back to `OTEL_ATTRIBUTE_COUNT_LIMIT`)               | Max attributes per span.                                                                                                                                                                     |
| `AttributeValueLengthLimit` (common) | no limit | `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` (falls back to `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`) | Max attribute value length; strings/byte-arrays MUST be truncated to the limit; for arrays of strings/AnyValue, the limit applies per element; all other value shapes MUST NOT be truncated. |
| `EventCountLimit`                    | 128      | `OTEL_SPAN_EVENT_COUNT_LIMIT`                                                                | Max events per span.                                                                                                                                                                         |
| `LinkCountLimit`                     | 128      | `OTEL_SPAN_LINK_COUNT_LIMIT`                                                                 | Max links per span.                                                                                                                                                                          |
| `AttributePerEventCountLimit`        | 128      | `OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT`                                                           | Max attributes per event.                                                                                                                                                                    |
| `AttributePerLinkCountLimit`         | 128      | `OTEL_LINK_ATTRIBUTE_COUNT_LIMIT`                                                            | Max attributes per link.                                                                                                                                                                     |

**Source (env vars):** https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#span-limits
and the neighboring "Attribute limits" table on that page.

**Attribute value types** (common spec, inherited by span attributes). Source:
https://opentelemetry.io/docs/specs/otel/common/#attribute. Attribute keys **MUST** be non-null,
non-empty strings. Key casing is preserved and case-sensitive (differently cased keys are distinct
keys). Attribute values **MUST** be one of the types defined by `AnyValue`: string, boolean,
double-precision float, signed 64-bit integer, byte array, homogeneous/nested arrays, maps, and
empty. Verified against the raw spec source (`specification/common/README.md` on `main`, 2026-07):
"The attribute value MUST be one of types defined in AnyValue." _Note:_ earlier spec versions
restricted plain `Attribute` values to primitives and homogeneous primitive arrays (no
maps/nesting). The current spec unifies `Attribute` with the broader `AnyValue` definition used by
log bodies. Third-party producers on older SDKs will emit the stricter, pre-unification subset.

---

## 14. ID Generators

**Stability: Stable** for the core requirement; **Development** for the self-identifying-randomness
extension.
**Source:** https://opentelemetry.io/docs/specs/otel/trace/sdk/#id-generators

"The SDK MUST by default randomly generate both the `TraceId` and the `SpanId`." The SDK **MUST**
provide a mechanism to customize ID generation for both, typically an `IdGenerator`-style
interface exposing `generateSpanIdBytes()` / `generateTraceIdBytes()`. Vendor-specific ID
generators (e.g. AWS X-Ray's ID format) **MUST NOT** be maintained or distributed as part of
OpenTelemetry's core packages.

**(Development)** Custom `IdGenerator`s **SHOULD** self-identify when _all_ generated TraceIDs meet
the W3C Trace Context Level 2 randomness bar, so the SDK can set the `Random` trace flag. This is
typically inferred statically via a marker interface rather than per call.

---

## 15. Span Processor {#span-processor-sdk}

**Stability: Stable**, except `OnEnding`, which is explicitly **Development**.
**Source:** https://opentelemetry.io/docs/specs/otel/trace/sdk/#span-processor

A `SpanProcessor` hooks span start and end. Processors are invoked **only** when `IsRecording` is
true. Built-in processors batch spans and convert them to an export-friendly representation before
handing them to exporters. Multiple processors register directly on the `TracerProvider` and run
**in registration order**. Each forms the head of its own pipeline (processor + optional exporter),
and the SDK **MUST** allow each pipeline to end with its own exporter. The SDK **MUST** allow users
to implement and register custom processors.

### Interface

The `SpanProcessor` interface **MUST** declare `OnStart`, `OnEnd`, `Shutdown`, `ForceFlush`, and
**SHOULD** declare `OnEnding`.

| Method                              | Timing / threading                                           | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OnStart(span, parentContext)`      | Synchronous, on the span-starting thread                     | MUST NOT block/throw. Multiple processors' `OnStart` run in registration order. `span` is a read/write span; keeping a reference and observing live updates SHOULD work (e.g. a processor that periodically inspects all active spans from a background thread). `parentContext` is the SDK-determined parent (explicit / current / empty, per what was requested). Returns void.                                                                                                                                         |
| `OnEnding(span)` (**Development**)  | Synchronous, inside `Span.End()`, _before_ `OnEnd`           | Called once the end timestamp is computed (its own duration is excluded from span duration) while the span is **still mutable** (`SetAttribute`/`AddLink`/`AddEvent` still legal). MUST NOT block/throw. Multiple processors' `OnEnding` run in registration order. The SDK MUST guarantee no other thread can modify the span once the first `OnEnding` starts; from that point only synchronous in-callback modification is allowed. **All** registered `OnEnding` callbacks run before **any** `OnEnd` callback runs. |
| `OnEnd(span)`                       | Synchronous, inside `Span.End()`, after end timestamp is set | MUST NOT block/throw. `span` is a readable span; even if technically mutable, modifying it here is not allowed (already ended).                                                                                                                                                                                                                                                                                                                                                                                           |
| `Shutdown()`                        | (n/a)                                                        | SHOULD be called only once; subsequent `OnStart`/`OnEnd`/`ForceFlush` calls SHOULD be gracefully ignored. MUST include the effects of `ForceFlush`. SHOULD report success/failure/timeout and SHOULD complete/abort within some timeout.                                                                                                                                                                                                                                                                                  |
| `ForceFlush()`                      | (n/a)                                                        | Hint to complete any in-flight span work "as soon as possible, preferably before returning." If the processor has an exporter, it SHOULD `Export` everything not yet exported, then call the exporter's `ForceFlush`; built-in processors **MUST** do so. If a timeout is set, the processor MUST prioritize the timeout over completeness (may abort/skip calls). SHOULD report outcome. SHOULD only be called when "absolutely necessary" (e.g. FaaS suspend-after-invocation risk).                                   |

### Built-in processors

The standard SDK **MUST** implement both. Other cross-cutting processing is steered toward the
out-of-process [Collector](https://opentelemetry.io/docs/specs/otel/overview/#collector) rather
than more built-in processors.

**Simple processor:** passes each span to the configured exporter as soon as it finishes. MUST
synchronize `Export` calls so they are never invoked concurrently. Configurable: `exporter`.

**Batching processor:** batches finished spans before handing them to the exporter; also MUST
synchronize `Export` calls. Once the previous export has returned, it exports a batch when any of
these holds:

- `scheduledDelayMillis` has passed since construction, or since the first span in a new window.
- `scheduledDelayMillis` has passed since the previous export timer ended or the previous export
  completed.
- The queue reaches `maxExportBatchSize`.
- `ForceFlush()` is called.

An empty queue at export time MAY export an empty batch or skip the export (implementation's
choice).

| Parameter              | Default | Env var                          | Meaning                                                                                                                           |
| ---------------------- | ------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `maxQueueSize`         | 2048    | `OTEL_BSP_MAX_QUEUE_SIZE`        | Spans beyond this are dropped once the queue is full.                                                                             |
| `scheduledDelayMillis` | 5000    | `OTEL_BSP_SCHEDULE_DELAY`        | Max delay between consecutive exports.                                                                                            |
| `exportTimeoutMillis`  | 30000   | `OTEL_BSP_EXPORT_TIMEOUT`        | How long a single export may run before being cancelled.                                                                          |
| `maxExportBatchSize`   | 512     | `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | Max spans per export call; must be ≤ `maxQueueSize`; reaching this triggers an export even before `scheduledDelayMillis` elapses. |

**Source (env vars):** https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#batch-span-processor

### Concurrency

Span processor: all methods **MUST** be safe for concurrent calls.

---

## 16. Span Exporter

**Stability: Stable.**
**Source:** https://opentelemetry.io/docs/specs/otel/trace/sdk/#span-exporter

Protocol-specific exporters implement the `SpanExporter` interface to plug into the SDK. The
interface keeps exporter implementation burden low: an exporter is meant to be "primarily a simple
telemetry data encoder and transmitter." Each implementation **MUST** document its own concurrency
requirements.

**Interface:** MUST support `Export`, `Shutdown`, `ForceFlush` (typically one interface per signal,
e.g. `SpanExporter`).

| Method          | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Export(batch)` | Exports a batch of readable spans (typically serialize + transmit). It "should not be called concurrently with other Export calls for the same exporter instance", though the underlying transmission MAY still happen concurrently (language-specific). **MUST NOT block indefinitely**: it must time out with `Failure` after a reasonable upper limit. Retry logic belongs to the **exporter**, not the built-in processors: "The default SDK's Span Processors SHOULD NOT implement retry logic", since retry is protocol/backend-specific (e.g. [OTLP](https://opentelemetry.io/docs/specs/otlp/) defines its own send/retry logic). Returns an `ExportResult`: `Success` ("the batch has been successfully exported", e.g. delivered over the wire) or `Failure` ("exporting failed. The batch must be dropped", e.g. unserializable data). |
| `Shutdown()`    | Opportunity for exporter cleanup; called on SDK shutdown. Should be called only once. Afterwards, `Export` calls are disallowed and **should return `Failure`**. Should not block indefinitely, even if flushing to an unavailable destination.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ForceFlush()`  | Hint that spans already received before the call should be exported "as soon as possible, preferably before returning." SHOULD report success/failure/timeout. SHOULD only be called when "absolutely necessary" (same FaaS-suspend rationale as the processor's `ForceFlush`). SHOULD complete/abort within some timeout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Concurrency:** `ForceFlush` and `Shutdown` **MUST** be safe to call concurrently on a `SpanExporter`.

---

## 17. SDK Concurrency requirements (summary)

**Source:** https://opentelemetry.io/docs/specs/otel/trace/sdk/#concurrency-requirements

| Component      | Requirement                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| TracerProvider | Tracer creation, `ForceFlush`, `Shutdown` MUST be safe for concurrent calls.                                                            |
| Sampler        | `ShouldSample` and `GetDescription` MUST be safe for concurrent calls.                                                                  |
| Span processor | All methods MUST be safe for concurrent calls.                                                                                          |
| Span Exporter  | `ForceFlush` and `Shutdown` MUST be safe for concurrent calls (per-instance `Export` itself must NOT be called concurrently; see above). |

---

## 18. Self-observability (SDK)

**Stability: Development.**
**Source:** https://opentelemetry.io/docs/specs/otel/trace/sdk/#self-observability

"The Tracing SDK SHOULD support
[SDK self-observability](https://opentelemetry.io/docs/specs/otel/self-observability/)": the SDK
emits metrics/logs about its own internal health (queue depth, export failures, etc.), separate
from the application's own telemetry. This is the spec-level counterpart to what `apps/ingest`
does by hand today: its operational metrics (`apps/ingest/src/metrics.rs`,
`apps/ingest/src/usage_metrics.rs`, pushed via a `PeriodicReader`) follow the shape this section
describes for SDKs.

---

## 19. Environment variable reference (sampler & exporter selection)

**Stability: Stable.**
**Source:** https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#general-sdk-configuration
(Trace Sampler / Trace Exporter subsections)

| Env var                   | Default                 | Accepted values / meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_TRACES_SAMPLER`     | `parentbased_always_on` | `always_on` (`AlwaysOnSampler`), `always_off` (`AlwaysOffSampler`), `traceidratio` (`TraceIdRatioBased`), `parentbased_always_on` (`ParentBased(root=AlwaysOnSampler)`), `parentbased_always_off` (`ParentBased(root=AlwaysOffSampler)`), `parentbased_traceidratio` (`ParentBased(root=TraceIdRatioBased)`), `parentbased_jaeger_remote` (`ParentBased(root=JaegerRemoteSampler)`), `jaeger_remote` (`JaegerRemoteSampler`), `xray` (AWS X-Ray centralized sampling, third-party). |
| `OTEL_TRACES_SAMPLER_ARG` | unset                   | Meaning depends on the selected sampler. For `traceidratio` / `parentbased_traceidratio`: "Sampling probability, a number in the [0..1] range, e.g. '0.25'. Default is 1.0 if unset." For `jaeger_remote` / `parentbased_jaeger_remote`: a comma-separated list of `endpoint`, `pollingIntervalMs`, `initialSamplingRate`.                                                                                                                                                          |
| `OTEL_TRACES_EXPORTER`    | `otlp`                  | `otlp`, `zipkin`, `console`, `logging` (deprecated alias), `none`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `OTEL_PROPAGATORS`        | `tracecontext,baggage`  | Ordered list of propagators to install globally. Not trace-specific, but it governs how `SpanContext`/`Baggage` cross process boundaries.                                                                                                                                                                                                                                                                                                                                            |

---

## Key references

- Trace API spec: https://opentelemetry.io/docs/specs/otel/trace/api/
  (raw: https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/trace/api.md)
- Trace SDK spec: https://opentelemetry.io/docs/specs/otel/trace/sdk/
  (raw: https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/trace/sdk.md)
- Trace spec overview / index: https://opentelemetry.io/docs/specs/otel/trace/
- TraceState handling: https://opentelemetry.io/docs/specs/otel/trace/tracestate-handling/
- Probability sampling in TraceState (`th`/`rv` sub-keys, consistent sampling math): https://opentelemetry.io/docs/specs/otel/trace/tracestate-probability-sampling/
- Common attribute & attribute-limits spec (`AnyValue`, `AttributeCountLimit`, `AttributeValueLengthLimit`): https://opentelemetry.io/docs/specs/otel/common/
- SDK environment variables (batch span processor, span/attribute limits, sampler & exporter selection, propagators): https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
- SDK self-observability: https://opentelemetry.io/docs/specs/otel/self-observability/
- Context & Propagators API: https://opentelemetry.io/docs/specs/otel/context/ , https://opentelemetry.io/docs/specs/otel/context/api-propagators/
- OTLP trace proto (wire-level `Status.StatusCode` enum spelling, `Span` message shape): https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
- Document status / stability-level definitions: https://opentelemetry.io/docs/specs/otel/document-status/
