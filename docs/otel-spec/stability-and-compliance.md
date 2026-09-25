# Versioning, Stability & Compliance

This is the meta-spec reference. It covers how the OpenTelemetry specification
defines maturity and stability, what "stable" forbids implementations from
doing, the error-handling and performance principles every SDK and
instrumentation must follow, and how to read the cross-language compliance
matrix. Everything else in `docs/otel-spec/` (semconv, OTLP, etc.) inherits its
stability guarantees from the concepts defined here.

> **Spec version referenced:** OpenTelemetry Specification **v1.58.0**
> (released 2026-06-22, per the
> [specification CHANGELOG](https://github.com/open-telemetry/opentelemetry-specification/blob/main/CHANGELOG.md)).
> Stability language quoted below is current as of that release. Re-check the
> CHANGELOG's "Unreleased" section when bumping this doc.

> [!NOTE] Relevance to Maple
> Maple is primarily a **consumer/backend** of OTel data (Rust ingest gateway →
> collector → ClickHouse/Tinybird → web dashboard). It is also a
> **self-instrumented emitter** of its own telemetry via `@maple-dev/effect-sdk`
> (`packages/effect-sdk`, built on Effect's native OTLP exporter in
> `effect/unstable/observability`). Three of the four stability domains below
> (API, SDK, telemetry/semconv) matter to us mostly as _producers_ (our own
> services). The fourth (OTLP wire format) matters to us as a _server
> implementor_ (`apps/ingest` accepting arbitrary upstream OTLP). We do not ship
> an OTel API/SDK for others to depend on, so the API/SDK LTS clauses are not
> obligations we owe. Read them as "what guarantees can we assume from the SDKs
> instrumenting the services that send us data."

---

## 1. Four stability domains

The spec separates stability into independent domains that version and evolve
on their own schedules. Conflating them is the most common compliance mistake.

| Domain                          | What it governs                                                                                                 | Governing doc                                                                                  | Versioning                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **API stability**               | Method signatures in `opentelemetry-api` packages (Tracer, Meter, Logger, Context, Propagators)                 | [Versioning and stability](https://opentelemetry.io/docs/specs/otel/versioning-and-stability/) | All stable API packages across all signals version together, one number, SemVer 2.0.0        |
| **SDK stability**               | Public SDK surface: plugin interfaces (`SpanProcessor`, `Exporter`, `Sampler`) and constructors/config/builders | Same doc, "SDK" sections                                                                       | SDK packages for all signals version together, independently from API                        |
| **Telemetry/semconv stability** | The _shape_ of emitted telemetry (span/metric/log names, attribute keys) that a stable instrumentation produces | [Telemetry Stability](https://opentelemetry.io/docs/specs/otel/telemetry-stability/)           | Semantic Conventions have their own single version number, independent of API/SDK            |
| **Wire (OTLP) stability**       | The protobuf/JSON wire protocol between SDKs, collectors, and backends                                          | [OTLP spec](https://opentelemetry.io/docs/specs/otlp/); see [otlp.md](otlp.md)                 | Versioned by `opentelemetry-proto` releases; the `v1` proto packages and `/v1/*` paths mark the major version |

Each domain can sit at a different maturity level at the same time. The Trace
**API** has been Stable since v1.0.0, but a given **instrumentation library's
telemetry** (e.g. HTTP semconv attribute names) can still be `Development` while
riding on a fully stable API and SDK. Maple's ingest gateway sees this directly.
Many spans we accept still carry `http.method`/`net.peer.name` (old semconv)
alongside `http.request.method`/`server.address` (new semconv), because
instrumentation libraries move through telemetry-stability transitions
independently of their host language's API/SDK version.

Source: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/, https://opentelemetry.io/docs/specs/otel/telemetry-stability/

---

## 2. Signal lifecycle levels (spec-wide)

The versioning-and-stability doc defines the lifecycle a **signal** (Traces,
Metrics, Logs, Profiles, Baggage) or a spec **feature** moves through:

| Level           | Guarantee                                                                                                                           | Notes                                                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Development** | None. "While signals are in development, breaking changes and performance issues MAY occur."                                        | Not feature-complete; may be discarded entirely. Long-term dependencies discouraged.                                                                                                                                               |
| **Stable**      | Backward compatible going forward. "Once a signal in Development has gone through rigorous testing, it MAY transition to Stable."   | Long-term dependencies now permissible. Transition itself must not break existing users: "OpenTelemetry clients MUST NOT be designed in a manner that breaks existing users when a signal transitions from Development to Stable." |
| **Deprecated**  | Same support guarantees as Stable, but scheduled for removal. Requires a stable replacement to exist first.                         |                                                                                                                                                                                                                                    |
| **Removed**     | Gone. "Support is ended by the removal of a signal from the release. The release MUST make a major version bump when this happens." |                                                                                                                                                                                                                                    |

Source: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/

### Document-level status markers (separate taxonomy)

Individual **specification documents** (not signals) carry their own, more
granular maturity marker at the top of the page. This is the taxonomy that
matters when reading any given spec page:

| Status                | Guarantee                                               | Exact language                                                                                                                |
| --------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Development**       | None; may be incomplete or unavailable.                 | "Bugs and performance issues are expected to be reported." Should not be used in production; may be removed without notice.   |
| **Alpha**             | Usable for "limited non-critical production workloads." | Interfaces/config "can change often without backward compatibility." Component may be dropped anytime without warning.        |
| **Beta**              | Interfaces "treated as stable whenever possible."       | Breaking changes should be minimized between releases (still possible).                                                       |
| **Release Candidate** | Feature-complete.                                       | "Breaking changes, including configuration options and the component's output, are only allowed under special circumstances." |
| **Stable**            | General availability.                                   | "Breaking changes ... are only allowed under special circumstances," with prior notice when possible.                         |
| **Deprecated**        | Frozen, sunset scheduled.                               | "Components that are included in distributions are expected to exist for at least two minor releases or six months."          |
| **Unmaintained**      | No active code owner.                                   | After six months in this state, may transition to Deprecated.                                                                 |
| _(no marker)_         | Treated as **Alpha**.                                   | Absence of a status is not "stable by default."                                                                               |

Documents whose sections carry differing statuses are labeled **"Mixed"** at
the top. Check the per-section status inline, not just the doc banner, before
treating any single paragraph as a stability guarantee.

Source: https://opentelemetry.io/docs/specs/otel/document-status/

**Practical rule for our compliance checks:** when citing a spec page as
justification for a design decision, record the status banner (and, for Mixed
docs, the section-level status) with the citation. A "Development"-status
paragraph is a preview, not a compliance requirement.

---

## 3. What "Stable" forbids: breaking-change policy

### API packages

> "Backward-incompatible changes to API packages MUST NOT be made unless the
> major version number is incremented."
>
> "All existing API calls MUST continue to compile and function against all
> future minor versions of the same major version."

Languages that ship binaries should also provide **ABI compatibility** for API
packages across minor versions.

### SDK packages

> "Public portions of SDK packages MUST remain backward compatible."

"Public" covers two categories:

1. **Plugin interfaces**: `SpanProcessor`, `Exporter`, `Sampler`, and
   equivalents. New methods may be _added_ to these interfaces without a major
   bump only if the host language allows it in a backward-compatible way (e.g.
   default interface methods).
2. **Constructors**: configuration objects, environment variables, builder
   APIs.

### Semantic conventions

Semconv defines a _breaking change_ as one that breaks "common usage of tooling
written against the telemetry it produces". That is a narrower, more practical
bar than pure API compatibility. Three tiers:

- **Allowed only via a published schema file** (so old→new transforms are
  mechanical): renaming span/metric/log/resource attributes; renaming metrics
  and span events.
- **Always allowed, no schema needed**: adding new attributes to an existing
  convention; adding new conventions for resource/span/metric types that didn't
  exist before.
- **Prohibited outright**: anything else that would require inventing a new
  schema transform format.

### Deprecation process

A signal or feature can only be marked Deprecated once a Stable replacement
exists. Deprecated code keeps full Stable-level support guarantees until it is
formally Removed, which requires a major version bump.

Source: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/, https://opentelemetry.io/docs/specs/otel/telemetry-stability/

---

## 4. Versioning scheme

- Follows **Semantic Versioning 2.0.0**.
- **Independent version tracks:** all stable API packages (across every
  signal) share one version number; all SDK packages share a separate one;
  Semantic Conventions have their own; contrib packages version independently.
  A major bump in one track does not imply a bump in another.
- **Major bump** required for any breaking change to a stable interface, or
  removal of a deprecated signal.
- **Minor bump**: backward-compatible additions, changes to Development-level
  signals, or a signal's maturity transition (e.g. Development → Stable).
- **Patch bump**: "Make no changes which would require recompilation or
  potentially break application code". Bug fixes, security fixes, docs only.

### Long-term support (LTS)

| Track   | Minimum support window after next major release |
| ------- | ----------------------------------------------- |
| API     | 3 years                                         |
| SDK     | 1 year                                          |
| Contrib | 1 year                                          |

During the API LTS window, the latest SDK minor version keeps receiving
bug and security fixes, and so do contrib packages from that era.

Source: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/

---

## 5. Error-handling principles (fail-safe requirements)

These rules should drive our best-practices skill's "never let telemetry take
down the host app" checks. They apply to our own self-instrumentation and to
what we tell users to expect from well-behaved upstream SDKs.

- **No unhandled exceptions at runtime:**
    > "OpenTelemetry implementations MUST NOT throw unhandled exceptions at
    > runtime." / "API methods MUST NOT throw unhandled exceptions when used
    > incorrectly by end users."
- **Fail-safe defaults over runtime failure:** implementations must "provide
  safe defaults for missing or invalid arguments" instead of failing.
- **Init-time failure is the one allowed exception:** libraries "MAY fail
  fast and cause the application to fail on initialization" but "MUST NOT
  cause the application to fail later at runtime." Blow up at startup if
  misconfigured, never mid-request.
- **SDK internal errors are isolated:** SDKs "MUST NOT throw unhandled
  exceptions for errors in their own operations". An exporter losing its
  connection to the collector must not propagate into user code.
- **Callback safety:** "API methods that accept external callbacks MUST
  handle all errors" raised by those callbacks.
- **No-op over null:** on a suppressed error, implementations "MUST return a
  'no-op' or any other 'default' object" rather than `null` or an exception.
- **Self-diagnostics instead of silent failure:** "Whenever the library
  suppresses an error that would otherwise have been exposed to the user,
  the library SHOULD log the error using language-specific conventions."
  Libraries are also "encouraged to expose self-troubleshooting metrics,
  spans, and other telemetry that can be easily enabled and filtered out by
  default."
- **User override:** "SDK implementations MUST allow end users to change the
  library's default error handling behavior for relevant errors."

Source: https://opentelemetry.io/docs/specs/otel/error-handling/

**Best-practice-skill translation:** any span/metric/log emission path we
write (in `apps/api`, `apps/ingest`, or client SDKs we recommend) must never
throw past its call site into request-handling code. It should swallow and
self-log instead. Our own async OTLP export and the `HttpMiddleware.TracerDisabledWhen`
filter (`apps/api/src/http/api-observability.ts`) already have this shape. That
design is spec compliance with error handling, not just an internal safety
measure.

---

## 6. Performance / blocking guidance

- **Non-blocking by default:** "Library should not block end user
  application by default."
- **Bounded memory:** "Library should not consume unbounded memory
  resource." The spec frames overhead as a trade-off the implementation must
  actively manage: instrumentation "should not degrade the end user
  application as possible."
- **Under load, choose between two failure modes:**
    1. _Preserve everything, risk memory pressure_: "Preserve all information
       but possible to consume many resources", or
    2. _Bound memory, drop data_: "Dropping some information under
       overwhelming load and show warning log to inform when information loss
       starts and when recovered." This mode should have configurable
       thresholds and ideally expose a metric approximating the effective
       sampling ratio caused by the drops.
- **Logs need their own filter valve:** "Logging could consume much memory
  by default if the end user application emits too many logs". The spec says
  implementations should "provide a way to filter logs to capture by
  OpenTelemetry" independent of the application's own logging volume.
- **Shutdown/flush must be boundedly blocking:** "The OpenTelemetry client
  could block the end user application when it shut down." Both `shutdown()`
  and explicit `flush()` should "support user-configurable timeout."

The spec sets no numeric overhead or allocation targets. This is qualitative
guidance, left to each SDK's own benchmarking.

Source: https://opentelemetry.io/docs/specs/otel/performance/

**Maple-specific read:** `apps/ingest`'s WAL, async OTLP forward, and startup
loopback guard are the bounded-blocking, configurable-drop behavior this
section calls for. Check any new self-instrumentation on hot paths (e.g.
per-request auth token validation, per-span-batch processing) against "does
this block the request" and "is memory bounded under burst," not just "does it
produce useful telemetry."

---

## 7. Library / instrumentation guidelines

Two source documents cover this: one on general client design principles, one
on native instrumentation practice.

### General client design (spec: library-guidelines)

- **Depend on API only, never SDK:** "Libraries, frameworks, and applications
  that want to be instrumented with OpenTelemetry take a dependency only on
  the API packages." This lets a library be instrumented without forcing a
  specific backend on its consumers.
- **Negligible overhead is a design constraint:** "It is also important that
  minimal implementation incurs as little performance penalty as possible, so
  that third-party frameworks and libraries that are instrumented with
  OpenTelemetry impose negligible overheads..."
- **Exporter package naming:** separately published exporters should follow
  the `opentelemetry-exporter-{vendor_name}` pattern (prefixed with
  "OpenTelemetry" and "Exporter").
- This document does _not_ cover span granularity or attribute hygiene. It
  defers to other spec sections (semantic conventions, API spec) for that.

Source: https://opentelemetry.io/docs/specs/otel/library-guidelines/

### Native instrumentation practice (concepts: instrumentation/libraries)

- **Why native over external hooks:** "Native library instrumentation with
  OpenTelemetry provides better observability and developer experience for
  users, removing the need for libraries to expose and document hooks."
  Custom logging hooks get replaced by the common OTel API, and
  traces/logs/metrics from library and application code end up "correlated
  and coherent."
- **Scope naming when you call `getTracer`/`getMeter`/`getLogger`:** "When
  obtaining the tracer, provide your library (or tracing plugin) name and
  version: they show up on the telemetry and help users process and filter
  telemetry." Example: `getTracer("demo-db-client", "0.1.0-beta1")`.
- **Pin to the earliest stable API:** "Use the earliest stable OpenTelemetry
  API (1.0.\*) and avoid updating it unless you have to use new features".
  This minimizes forced version churn for consumers of the instrumented
  library.
- **Register it:** "Add your instrumentation library to the OpenTelemetry
  registry so users can find it."

### Instrumentation Scope: identity and naming (concepts: instrumentation-scope)

An Instrumentation Scope is "a logical unit of software with which emitted
telemetry is associated. It can represent a module, package, class, library,
or framework." It is identified by a `(name, version, schema_url, attributes)`
tuple. Only `name` is required, and "the `name` should uniquely identify the
logical unit of software, for example, the fully qualified name of a library,
class, or module."

Naming guidance by situation:

| Situation                                                                 | Convention                                                                              | Example                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Library/framework with native instrumentation                             | Library's own fully qualified name + version                                            | n/a                                                                          |
| Third-party library, no native support (external instrumentation library) | Fully qualified name/version of the _instrumentation_ library itself, often reverse-DNS | `io.opentelemetry.contrib.mongodb`, `io.opentelemetry.instrumentation.flask` |
| OpenTelemetry-hosted contrib instrumentation                              | `opentelemetry-instrumentation-<instrumented-lib>` package-name prefix                  | `opentelemetry-instrumentation-flask`                                        |
| Application-level code (not a library)                                    | Class or module name                                                                    | `CheckoutService`                                                            |

Every span, metric, and log record produced by a given tracer/meter/logger is
tagged with that instance's scope. This lets backends group and filter
telemetry by originating component and compare across library versions.

Source: https://opentelemetry.io/docs/specs/otel/library-guidelines/, https://opentelemetry.io/docs/concepts/instrumentation/libraries/, https://opentelemetry.io/docs/concepts/instrumentation-scope/

**Maple-specific read:** our services already follow the spec's identity model
at the _Resource_ level (`service.name="ingest"`, `service.version`,
`service.instance.id`). Instrumentation Scope is the finer-grained sibling. If
we split internal tracer usage across modules inside `apps/api` (e.g. a
distinct tracer for alerting vs. the query engine), each should get its own
scope name (e.g. `maple.alerting`, `maple.query-engine`) and version instead of
one service-wide tracer. Dashboard users can then filter by component the same
way they filter by service.

---

## 8. Telemetry stability guarantees (semconv-adjacent, distinct from API/SDK)

This document governs **the shape of telemetry emitted by instrumentations**,
a different axis from API/SDK code stability.

- **Unstable instrumentations:** no guarantees. "Unstable instrumentations
  provide no guarantees about the shape of the telemetry they produce and how
  that shape changes over time."
- **Stable instrumentations** split into two sub-cases:
    - **Fixed-schema producers** (stable, no Schema URL attached): "Such
      instrumentations are prohibited from changing any produced telemetry",
      even to adopt a newer semconv release, unless they migrate to
      schema-file-driven status.
    - **Schema-file-driven producers** (stable, Schema URL attached): as of
      the fetched page, this path is **under moratorium** and held to the same
      no-change restriction as fixed-schema producers. Once the moratorium
      lifts, changes are allowed only if they (a) match a released OTel semconv
      version, (b) ship a corresponding published schema file, and (c)
      correctly update the Schema URL.
- **Allowed regardless of tier:** "Adding of new metrics, spans, span events
  or log records and adding of new attributes."

Source: https://opentelemetry.io/docs/specs/otel/telemetry-stability/

**Why this matters for our ingest gateway:** telemetry-shape stability is
decoupled from API/SDK stability, so a long-since-1.0 SDK can still emit spans
whose attribute names are mid-migration (old vs. new HTTP semconv, for
instance). Maple's ClickHouse materialized views (`service_overview_spans_mv`,
etc.) coalesce legacy and current attribute spellings for this reason, e.g.
`deployment.environment.name` / `deployment.environment` (see
`packages/domain/src/tinybird/semconv-renames.ts` and
[attributes.md](../attributes.md)). That coalescing is the correct way to
consume telemetry from instrumentations that are Stable at the API level but
still transitioning at the telemetry-shape level.

### Schema URL / Telemetry Schema mechanics

A **Schema URL** identifies a **Schema File**: a YAML document describing one
version of a Schema Family, plus the transforms needed to convert older
compatible telemetry in that family up to this version. Mechanically:

- The URL's last path segment is the schema version. Everything before it is
  the **Schema Family identifier**, which all schema versions in one family
  share.
- Fetchers **must** follow HTTP redirects when resolving a Schema URL.
- In OTLP, `schema_url` on `ResourceSpans`/`ResourceMetrics`/`ResourceLogs`
  applies to the contained `Resource` and its spans/metrics/logs. A
  scope-level `schema_url` (on `ScopeSpans`/`ScopeMetrics`/`ScopeLogs`, the
  successor to the deprecated `InstrumentationLibrarySpans` etc.) applies only
  to the telemetry items for that scope.
- The mechanism exists for one narrow purpose: "to allow OpenTelemetry
  Semantic Conventions to evolve over time" without breaking consumers who pin
  to an older schema version.

Source: https://opentelemetry.io/docs/specs/otel/schemas/, https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/schemas/README.md

---

## 9. Glossary: terms load-bearing for this doc

| Term                          | Definition                                                                                                                                                                                                   | Source                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Signal**                    | "OpenTelemetry is structured around signals, or categories of telemetry. Metrics, logs, traces, profiles, and baggage are examples of signals."                                                              | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/)                                 |
| **Instrumented Library**      | "The library for which the telemetry signals (traces, metrics, logs) are gathered."                                                                                                                          | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/)                                 |
| **Instrumentation Library**   | "The library that provides the instrumentation for a given Instrumented Library. Instrumented Library and Instrumentation Library may be the same library if it has built-in OpenTelemetry instrumentation." | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/)                                 |
| **Instrumentation Scope**     | "A logical unit of software with which emitted telemetry is associated. It can represent a module, package, class, library, or framework." Identified by `(name, version, schema_url, attributes)`.          | [Instrumentation Scope concept](https://opentelemetry.io/docs/concepts/instrumentation-scope/) |
| **Telemetry SDK**             | "The library that implements the OpenTelemetry API."                                                                                                                                                         | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/)                                 |
| **Manual Instrumentation**    | "Coding against the OpenTelemetry API to collect telemetry from end user code or shared frameworks."                                                                                                         | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/)                                 |
| **Automatic Instrumentation** | "Telemetry collection methods that do not require the end user to modify application's source code."                                                                                                         | [Glossary](https://opentelemetry.io/docs/specs/otel/glossary/)                                 |
| **Schema URL**                | Identifier for a Schema File; last path segment is the version, the prefix is the Schema Family identifier; resolution must follow redirects.                                                                | [Telemetry Schemas](https://opentelemetry.io/docs/specs/otel/schemas/)                         |
| **Telemetry Schema**          | "The expected shape and composition of emitted telemetry data," versioned so Semantic Conventions can evolve without breaking pinned consumers.                                                              | [Telemetry Schemas](https://opentelemetry.io/docs/specs/otel/schemas/)                         |

The glossary page has no standalone entries for Resource, Baggage, Sampler, or
Context Propagation. Those are defined in their own spec sections (Resource SDK,
Baggage API, Trace SDK, Context API). Treat the glossary as authoritative only
for the terms it lists.

Source: https://opentelemetry.io/docs/specs/otel/glossary/

---

## 10. The spec compliance matrix: how to read it

The living source of truth for "does implementation X support feature Y" is:

**https://github.com/open-telemetry/opentelemetry-specification/blob/main/spec-compliance-matrix.md**

Structure (do not copy the matrix itself; it changes often, so link and
re-fetch):

- **Rows** are individual spec requirements, grouped under section headers
  for the major component areas:
    1. **Traces**: TracerProvider ops, context interaction, Tracer ops,
       SpanContext, span creation/lifecycle, attributes, links, events,
       exceptions, sampling, ID generation.
    2. **Baggage**: basic support, header naming.
    3. **Metrics**: MeterProvider, Meter ops, instrument types, Views,
       aggregations, exemplars, cardinality limits.
    4. **Logs**: LoggerProvider, Logger ops, LogRecord handling, processors.
    5. **Resource**: creation, merging, detection.
    6. **Context Propagation**: Context management, composite propagators,
       standard propagators (TraceContext, B3, Jaeger, OpenCensus).
    7. **Environment Variables**: `OTEL_*` configuration knobs.
    8. **Declarative Configuration**: YAML-based SDK setup.
    9. **Exporters**: stdout, in-memory, OTLP, Zipkin, Prometheus
       compatibility.
- **Columns** are per-language implementations: Go, Java, JavaScript, Python,
  Ruby, Erlang, PHP, **Rust**, C++, .NET, Swift, Kotlin.
- **Legend:** `+` supported, `-` unsupported, `N/A` not applicable, blank =
  unknown/unreported. An **Optional** column marks optional features with `X`.
  Unmarked rows are required for a language to claim compliance.

**Caveats for Maple's stack:**

- **Rust** has its own column (relevant to `apps/ingest`). The matrix tracks
  _SDK/client_ conformance (an implementation emitting telemetry), not
  _server/collector_ conformance (accepting OTLP). Our ingest gateway is closer
  to an OTLP _receiver_ than to any row in this matrix, so the matrix doesn't
  grade us directly. It is the right place to check what we can assume from
  Rust-instrumented services sending us data.
- **JavaScript** governs the `@opentelemetry/*` packages under our browser SDK
  (`@maple-dev/browser`) and any JS service sending us data. Our server-side
  self-instrumentation uses Effect's own OTLP exporter, not the JS OTel SDK.
  There is no separate Bun or workerd column: they are JS runtimes and inherit
  the JavaScript column. Runtime-specific gaps (e.g. Workers-runtime clock and
  timer quirks) are runtime bugs, not spec non-compliance, and won't show up in
  this matrix.
- The matrix is **self-reported per language SIG** and updated asynchronously
  from releases. Treat a blank cell as "unverified," not "unsupported."

Source: https://github.com/open-telemetry/opentelemetry-specification/blob/main/spec-compliance-matrix.md

---

## 11. How Maple should use this spec

**(a) The ingest gateway as an OTLP server.** `apps/ingest` is not a client
SDK, so most of Sections 1–4 (API/SDK versioning obligations) don't bind us
directly. What does bind us:

- **Error-handling principles (Section 5) apply to servers too.** A
  malformed, oversized, or undecodable payload from a misbehaving client must
  never crash the gateway. `otel_status_for_rejection` in
  `apps/ingest/src/main.rs` sets the server span status: 5xx, and 4xx
  rejections that drop the caller's telemetry (`rejection_loses_data` in
  `apps/ingest/src/otel.rs`: `bad_request`, `decode`, `enrich`), are `Error`.
  Rejections of the caller itself (bad key, throttle, oversized payload) stay
  `Ok` and remain observable via `http.response.status_code`/`error.type`.
  That is the fail-safe-defaults principle applied to a receiver.
- **Performance/blocking guidance (Section 6)** governs the WAL + async
  forward design and the startup loopback guard. Bounded memory and
  non-blocking behavior under load are what the spec calls for.
- **Telemetry-shape stability (Section 8)** is why we must tolerate mixed
  old/new semantic conventions in inbound payloads indefinitely. Clients are
  never obligated to be on the latest semconv, and "Stable" telemetry
  producers are largely frozen at whatever shape they shipped. Schema-URL
  transforms are the spec-sanctioned way to handle this. Our materialized
  views reach the same result by coalescing spellings, without keying off
  literal `schema_url` values.

**(b) Our self-instrumentation.** When `apps/ingest`, `apps/api`, or any new
service adds tracing:

- Use **Instrumentation Scope naming** (Section 7) deliberately: one scope
  per logical component (e.g. `maple.ingest`, `maple.alerting`), not one
  global tracer, so the scope tuple is useful for filtering.
- Justify new spans on hot or high-frequency paths against the performance
  guidance (Section 6): non-blocking, bounded memory, and where it fits,
  excluded by the `HttpMiddleware.TracerDisabledWhen` filter. The "Self-tracing"
  rule in CLAUDE.md (keep that filter and avoid spans on token validation) is a direct
  application of Section 6.
- Any place that swallows or re-throws telemetry-related errors should follow
  Section 5: log and continue, never propagate into request handling, never
  let OTLP export failures affect the response (already true today, since
  export is async).

**(c) The UI's interpretation of data.** The dashboard trusts specific
semconv-adjacent contracts as if they were part of the wire stability
guarantee (Section 1's fourth domain). **Span status codes** must be Title Case
(`"Ok"`, `"Error"`, `"Unset"`) per Maple's data convention, and error-rate
dashboards filter strictly on `StatusCode='Error'`. The HTTP semconv rule that
only 5xx is `Error` on server spans means our error dashboards depend on
upstream instrumentations following that status mapping. If an upstream SDK
sets `Error` for a 4xx (a spec violation, or an older or nonconforming
instrumentation), our dashboards over-count errors. This is a real
spec-compliance risk that deserves a validation pass on ingest, not just a UI
fix. More generally, a dashboard heuristic that assumes "stable telemetry never
changes shape" (Section 8) is safe **only** for genuinely Stable, fixed-schema
producers. Alpha, Beta, and Development instrumentations (the document status
ladder in Section 2) can change attribute names without notice. The UI and
query layer should degrade gracefully (missing attribute → omit facet, not
crash) instead of assuming presence.

---

## Key references

- Versioning and stability: https://opentelemetry.io/docs/specs/otel/versioning-and-stability/
- Document status (Development/Alpha/Beta/RC/Stable/Deprecated/Unmaintained): https://opentelemetry.io/docs/specs/otel/document-status/
- Telemetry stability guarantees: https://opentelemetry.io/docs/specs/otel/telemetry-stability/
- Error handling principles: https://opentelemetry.io/docs/specs/otel/error-handling/
- Performance and blocking guidance: https://opentelemetry.io/docs/specs/otel/performance/
- Library guidelines (client design principles): https://opentelemetry.io/docs/specs/otel/library-guidelines/
- Native instrumentation for libraries: https://opentelemetry.io/docs/concepts/instrumentation/libraries/
- Instrumentation Scope concept: https://opentelemetry.io/docs/concepts/instrumentation-scope/
- Telemetry Schemas: https://opentelemetry.io/docs/specs/otel/schemas/ and https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/schemas/README.md
- Glossary: https://opentelemetry.io/docs/specs/otel/glossary/
- Spec compliance matrix (living source, re-fetch before relying on cell values): https://github.com/open-telemetry/opentelemetry-specification/blob/main/spec-compliance-matrix.md
- Specification CHANGELOG (version history): https://github.com/open-telemetry/opentelemetry-specification/blob/main/CHANGELOG.md
