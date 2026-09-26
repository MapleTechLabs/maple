# Emerging Signals & Compatibility (Profiles, Schemas, Prometheus, Shims)

This page covers the parts of the OpenTelemetry spec tree that are either **not yet stable**
(Profiles signal, Entities) or **exist to bridge OTel with something else** (telemetry
schemas' rename/transform machinery, and the OpenCensus/OpenTracing/Prometheus compatibility
specs). Maple is primarily a _consumer_ of OTLP data and a _producer_ of its own
self-instrumentation. This doc flags (a) data we may see on the wire that isn't "plain" OTLP
yet, (b) a signal (Profiles) we don't ingest today but should plan schema and storage for, and
(c) the principled alternative to the legacy-field coalescing we already do by hand.

> **Stability key used below:** spec documents carry a status from the ladder Development →
> Alpha → Beta → Release Candidate → Stable, then Deprecated → Removed (see
> [stability-and-compliance.md](stability-and-compliance.md)). See the `Source:` links per claim.
> Do not assume anything in this file is Stable unless it is marked so.

## Relevance to Maple

- **Profiles: not ingested today.** Maple's pipeline (Rust ingest gateway →
  ClickHouse/Tinybird, optionally via a collector) has no Profiles datasource, no `/v1development/profiles` route, and no
  schema for `Profile`/`Sample`/`Location`/`Function` tables. If we add it, expect a
  dictionary-compressed, pprof-derived shape (below), not flat rows like spans and logs. That
  changes the storage model: string, location, and function tables are shared across samples
  within a profile, which is closer to how we dedupe attribute tables than to how we store span
  rows.
- **Telemetry schemas are the principled version of what we do by hand.** The warehouse
  coalesces legacy and current spellings on read: `db.system` / `db.system.name` and
  `db.statement` / `db.query.text` (`DB_SYSTEM_ATTR_SQL`, `DB_STATEMENT_SQL` in
  `packages/domain/src/tinybird/db-query-shape-sql.ts`), and `deployment.environment` /
  `deployment.environment.name` (`DEPLOYMENT_ENV_SQL` in
  `packages/domain/src/tinybird/semconv-renames.ts`). Maple's own services dual-emit both
  environment keys (e.g. `apps/ingest/src/otel.rs`). That is the `rename_attributes` transform a
  schema file encodes formally. Ingest stores `schema_url` (the `resource_schema_url` and
  `scope_schema_url` columns) but nothing reads it to drive this; it is manual per-attribute
  logic. This doc is the reference for a schema-aware coalescing layer if we ever generalize it.
- **Prometheus/OpenMetrics naming rules matter directly** if Maple ever accepts Prometheus
  remote-write, scrapes `/metrics` from anything, or exposes an OTLP→Prometheus bridge for
  customers. The `_total`/unit-suffix/`target_info` rules below are the translation table to
  implement or validate against.
- **OpenCensus/OpenTracing shim artifacts can show up in customer data** from services
  mid-migration (the "OpenTelemetry sandwich" pattern), e.g. an `opentracing.ref_type` span
  attribute, or span links that originated as OpenCensus `Link`s. Both shims are deprecated
  specs, so this is legacy-interop knowledge, not something to build new support for.
- **Entities** (pointer only) is a Development-stage remodeling of Resource that every signal,
  including Profiles, will eventually attach to. Worth tracking, not actionable yet.

---

## 1. Profiles signal

### Status

- Signal/data-model stability: **Alpha** (explicitly "should not be used for critical
  production workloads"). `Source: https://opentelemetry.io/docs/specs/otel/profiles/`,
  `Source: https://opentelemetry.io/docs/specs/status/`, `Source: https://opentelemetry.io/blog/2026/profiles-alpha/`
- Protocol (OTLP transport) stability: **Development**. The spec's own status table lists
  "Protocol: development" for profiles, distinct from the Stable protocol status for
  traces/metrics/logs. `Source: https://opentelemetry.io/docs/specs/status/`
- Wire/endpoint: default path is **`/v1development/profiles`** (an `ExportProfilesServiceRequest`
  protobuf). The `v1development` path segment signals non-stable status; it drops to `v1` only
  once the proto reaches release candidate. `Source: https://opentelemetry.io/docs/specs/otlp/`
- The signal entered **public Alpha on 2026-03-26**; roadmap targets Beta then GA, with GA
  originally hoped for ~Q3 2026 per community commentary (treat that date as unconfirmed: it
  comes from secondary sources, not the spec).
  `Source: https://opentelemetry.io/blog/2026/profiles-alpha/`

Every message-level type below (`Profile`, `Sample`, `Location`, `Function`, `Mapping`, `Link`,
`ProfilesDictionary`) is itself annotated **Alpha** in the current proto.
`Source: https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/profiles/v1development/profiles.proto`

### Data model shape (pprof-derived, dictionary-compressed)

The model **modifies the pprof protobuf format**, adding OTel-native concepts (Resource,
InstrumentationScope, trace/span links, semconv attributes) while preserving round-trip
conversion to/from pprof "with no loss of information."
`Source: https://opentelemetry.io/docs/specs/otel/profiles/`,
`Source: https://opentelemetry.io/blog/2026/profiles-alpha/`

Key design point for a backend: **profiles are not flat sample rows.** A `ProfilesDictionary`
holds shared tables that samples reference by index, deduplicating everything that repeats
across a profile (the same dedup trick as an attribute/string table, applied to stack frames
too):

- `mapping_table` (`Mapping[]`): binary/library memory regions (load address, file offset,
  filename index) that a stack address falls into.
- `location_table` (`Location[]`): a single stack frame: which `Mapping`, an instruction
  `address`, and one or more `Line`s (to represent inlined frames) each pointing at a `Function`.
- `function_table` (`Function[]`): function metadata (human-readable name, system
  (e.g. mangled) name, source filename, starting line), all as string-table indices.
- `link_table` (`Link[]`): the cross-signal join: a `trace_id` + `span_id` pair a sample can
  point at.
- `string_table` (`string[]`): shared strings referenced everywhere else by index.
- `attribute_table` (`KeyValueAndUnit[]`): key/value/unit triples (UCUM unit as a string index),
  referenced by index from `Profile`, `Sample`, `Location`, and `Mapping`.
- `stack_table` (`Stack[]`): a deduplicated call stack (sequence of `Location` indices), shared
  across samples that hit the same stack.

`Profile` (the batch-level container) then carries: `sample_type` (a `ValueType` = measurement
kind + unit, e.g. `cpu`/`nanoseconds`), `samples[]`, `time_unix_nano`, `duration_nano`,
`period_type`/`period` (sampling interval descriptor), a 16-byte `profile_id`,
`dropped_attributes_count`, and optionally the **original untouched payload**
(`original_payload_format` + `original_payload` bytes) for lossless pprof round-trip.

`Sample` is the actual observation: a `stack_index` into `stack_table`, `attribute_indices` for
sample-specific attributes, `values[]` (the measured quantities, e.g. CPU ns, allocated bytes),
optional `timestamps_unix_nano[]`, and a `link_index` into `link_table` (0 = none, following the
dictionary convention that index 0 is a null sentinel throughout).
`Source: https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/profiles/v1development/profiles.proto`

### Linking profiles to traces

A `Sample` MAY carry a `Link` (via `link_index` → `link_table` → `{trace_id, span_id}`),
enabling direct "what code was running during this span" correlation. The profiles concept
page frames this as answering "which code is responsible" as a complement to an existing trace
or span. Otherwise correlation works as it does for every signal: shared
Resource/InstrumentationScope context.
`Source: https://opentelemetry.io/docs/specs/otel/profiles/`,
`Source: https://opentelemetry.io/docs/concepts/signals/profiles/`

### What a backend would need to store/query profiles (implication, not spec text)

Given the shape above, ingesting Profiles is architecturally closer to ingesting a small
relational bundle per batch (dictionary tables + samples referencing them by index) than to
appending flat rows. A ClickHouse-style backend would plausibly need either (a) to materialize
the dictionary tables into their own keyed tables and resolve indices at query time, or (b) to
fully denormalize each sample (function names, file, line, mapping) at ingest, trading storage
for query simplicity, the same trade-off Maple makes for span attributes. Cross-signal
correlation (`trace_id`/`span_id` on `Link`) is the one piece that maps cleanly onto existing
trace-join infrastructure. **Maple does not implement any of this today.** This section is
forward-looking.

### Collector-side status (pointer, not spec)

The OpenTelemetry Collector is **not part of the specification**; it is a reference
implementation. As context: the 2026 Alpha announcement highlights a `pprof` receiver,
Kubernetes metadata enrichment, OTTL transforms for profiles, and an eBPF profiling agent
donated by Elastic, now distributed as part of the official Collector distribution. None of
this is spec-mandated behavior.
`Source: https://opentelemetry.io/blog/2026/profiles-alpha/` ·
Collector docs (non-spec): `https://github.com/open-telemetry/opentelemetry-collector`

---

## 2. Telemetry schemas (deep dive)

### Status

**Stable.** `Source: https://opentelemetry.io/docs/specs/otel/schemas/`

The Schema File Format sub-spec (versions 1.0.0 and 1.1.0) is versioned separately. The current
file format spec (1.1.0) is marked **Development** in its own document header, even though the
"Telemetry Schemas" concept page is Stable. Read the file-format details as less settled than
the top-level mechanism.
`Source: https://opentelemetry.io/docs/specs/otel/schemas/file_format_v1.1.0/`

### Why schemas exist

Semantic conventions evolve (attributes get renamed, split, etc.), but telemetry producers,
telemetry consumers, and the semantic conventions themselves all evolve independently: "the
coupling complicates the independent evolution of these 3 parties." A schema is the versioned,
machine-readable description of _what changed between semconv versions_ so a consumer can
transform old-shaped data into the shape it expects (or vice versa) without bespoke code per
field rename. `Source: https://opentelemetry.io/docs/specs/otel/schemas/`

### `schema_url` mechanics end-to-end

1. **Format:** `http[s]://server[:port]/path/<version>`. Everything before `<version>` is the
   **Schema Family** identifier. Every version in a family shares that prefix.
2. **Where it's attached in OTLP:** `schema_url` fields exist on `ResourceSpans`,
   `ResourceMetrics`, `ResourceLogs` and on the scope-level messages
   `ScopeSpans`/`ScopeMetrics`/`ScopeLogs` (formerly `InstrumentationLibrary*`). They cover
   different data. The resource-level value applies only to the `resource` field. Each scope-level
   value applies to that scope's spans, metrics, or logs.
3. **Immutability + caching:** "Schema files are immutable once they are published". Once you've
   resolved a `schema_url` to a file, it is safe to cache that resolution permanently. Fetchers
   must follow HTTP redirects. Consumers/backends MAY bundle known schema files at build time
   instead of fetching over the network at all.
4. **Versioning:** MAJOR.MINOR.PATCH with SemVer 2.0 ordering. For anyone mapping this to
   semconv: **"OpenTelemetry schema version numbers match OpenTelemetry Semantic Conventions
   version numbers,"** so schema `1.27.0` corresponds to semconv `1.27.0`.

`Source: https://opentelemetry.io/docs/specs/otel/schemas/`

### Schema file format (1.1.0)

A schema file is YAML:

```yaml
file_format: 1.1.0
schema_url: /schemas/1.2.0
versions:
    1.2.0:
        all:
            changes: [...]
        resources:
            changes: [...]
        spans:
            changes: [...]
        span_events:
            changes: [...]
        metrics:
            changes: [...]
        logs:
            changes: [...]
```

- `file_format` must literally be `"1.1.0"`.
- `schema_url`'s trailing version must equal the highest version key present under `versions`.
- The **`all`** section's transforms apply first, to every signal type; then per-signal sections
  apply on top.
- Transformations are **intentionally minimal** ("we intentionally limit the types of
  transformations of schemas to the bare minimum"). This is not a general ETL DSL.

Transform types by section, per the 1.1.0 format:

| Section       | Supported transforms                           |
| ------------- | ---------------------------------------------- |
| `all`         | `rename_attributes`                            |
| `resources`   | `rename_attributes`                            |
| `spans`       | `rename_attributes`                            |
| `span_events` | `rename_events`, `rename_attributes`           |
| `metrics`     | `rename_metrics`, `rename_attributes`, `split` |
| `logs`        | `rename_attributes`                            |

`rename_attributes`, the one most relevant to Maple's manual coalescing, takes an
`attribute_map` of old→new names, optionally scoped to specific span names / event names / metric
names via `apply_to_spans` / `apply_to_events` / `apply_to_metrics`:

```yaml
- rename_attributes:
      attribute_map:
          old_name: new_name
      apply_to_spans: [span_name]
      apply_to_events: [event_name]
      apply_to_metrics: [metric_name]
```

`rename_metrics` renames a metric name outright; `split` breaks one metric into several by an
attribute's value (e.g. `system.paging.operations` split by `direction` into
`system.paging.operations.in` / `.out`).

Version 1.1.0 added the `split` transform to the `metrics` section; the rest of the declarative
transform framework already existed in 1.0.0. Tooling walks a chain of schema versions and
applies or reverses the diffs automatically, instead of each consumer hand-rolling migrations.
`Source: https://opentelemetry.io/docs/specs/otel/schemas/file_format_v1.1.0/`

### Applying transformations (the pattern Maple's manual coalescing approximates)

Two implementation patterns the spec describes:

1. **Schema-aware backend:** compare the `schema_url` on incoming data against the schema
   version the backend wants; walk the schema file's declared changes between those versions;
   apply them (e.g. the spec's own example, renaming `deployment.environment` to
   `environment`). This is the shape of the `deployment.environment` →
   `deployment.environment.name` rename, which Maple handles by **dual-emitting both keys** from
   its own services and coalescing on read, not by reading `schema_url` and transforming. We get
   the outcome without the mechanism.
2. **Collector-Assisted Schema Transformation:** delegate the conversion to an OpenTelemetry
   Collector's Schema Translate Processor sitting in the pipeline, so producers/consumers never
   need schema logic themselves.

`Source: https://opentelemetry.io/docs/specs/otel/schemas/`

**Note for Maple:** `apps/ingest` stores `schema_url` from ingested `ResourceSpans` /
`ResourceMetrics` / `ResourceLogs` as a column but never uses it to transform data. The
legacy-field coalescing (`db.statement`/`db.system` ↔ `db.query.text`/`db.system.name`,
`deployment.environment` ↔ `deployment.environment.name`) is hand-written per-attribute SQL, not
schema-driven. If schema-aware coalescing is ever generalized, this is the mechanism to build on.

---

## 3. Prometheus & OpenMetrics compatibility

### Status

**Stable**, with two carve-outs the spec itself marks **Development**: resource-attribute →
`target_info`/`job`/`instance` handling, and Prometheus "Unknown"-type metric handling.
`Source: https://opentelemetry.io/docs/specs/otel/compatibility/prometheus_and_openmetrics/`

### OTLP → Prometheus naming rules

- **Unit suffixes:** UCUM units are mapped to Prometheus unit words via a lookup table (`By` →
  `bytes`, `ms` → `milliseconds`, etc.); bracketed annotations like `{packet}` are dropped; units
  expressed as rates (`m/s`) become `_per_` words (`meters_per_second`). The resulting unit
  **SHOULD** also be set as OpenMetrics `UNIT` metadata. A unit suffix **SHOULD** be appended to
  the metric name unless the name already ends with it (before any type suffix).
- **`_total` suffix:** for monotonic Sum points, a `_total` suffix **SHOULD** be added by default
  if not already present; if already present, the name **MUST** stay unchanged (no double
  suffixing).
- **Character sanitization:** characters Prometheus discourages in metric names **SHOULD** be
  replaced with `_` by default, and repeated `_` collapsed to one.
- **Resource attributes → `job`/`instance`/`target_info`:** `service.namespace` and
  `service.name` **MUST** combine into `<namespace>/<name>` (or just `<name>` if no namespace) to
  form the `job` label; `service.instance.id`, if present, **MUST** become the `instance` label
  (else `instance` is emitted empty). Other resource attributes **SHOULD** become a synthetic
  `target_info` metric (an OpenMetrics "info" metric or, if the client library lacks info-metric
  support, a gauge named `target_info` with constant value `1`) or **MUST** be dropped.
  _(Development status.)_
- **Untyped/Gauge round-trip:** exporting an OTLP Gauge back toward Prometheus, if the datapoint
  carries a `prometheus.type` attribute equal to `unknown`, it **MUST** become a Prometheus
  Unknown-typed sample. _(Development status.)_

### Prometheus → OTLP naming rules

- By default, label keys/values **MUST NOT** be altered (e.g. no automatic `_`→`.` translation).
  This direction is lossier and more speculative than OTLP→Prom, so the spec is conservative.
- `UNIT` metadata, if present on the Prometheus side, **MUST** be converted into the OTLP metric's
  unit.
- A Prometheus **Unknown**-typed metric **MUST** be converted to an **OTLP Gauge** on ingest.
  _(Development status.)_
- Summary quantiles carry a `quantile` label with the stringified float (e.g. `0.99`); histogram
  buckets use Prometheus's standard `le` (less-than-or-equal) label. The spec adds no bucket-naming
  rules beyond these Prometheus/OpenMetrics conventions.

`Source: https://opentelemetry.io/docs/specs/otel/compatibility/prometheus_and_openmetrics/`

---

## 4. OpenCensus compatibility (shim)

### Status

**Deprecated** as of **June 2026**; removal not before **June 2027**. Existing shims MAY keep
being supported, but implementing new OpenCensus compatibility is explicitly not required by the
spec going forward. `Source: https://opentelemetry.io/docs/specs/otel/compatibility/opencensus/`

### What it guarantees / why customer data may show OpenCensus artifacts

The shim implements the OpenCensus Trace API and a Stats/Metrics bridge (`OpenCensus-Metrics-Shim`
implementing `MetricProducer`) on top of OpenTelemetry, so legacy OpenCensus instrumentation can
keep running unmodified while everything around it moves to OTel. It guarantees parent/child span
relationships and span **Links** survive translation, and both push/pull metric exporters keep
working, covering Gauges, Counters, Cumulative Histograms, and Summaries. The reason a Maple
customer's data could carry OpenCensus fingerprints is the well-known **"OpenTelemetry
sandwich"**: outer application layers adopt OTel first while inner dependencies are still on
OpenCensus, and the shim bridges the two until migration completes.
`Source: https://opentelemetry.io/docs/specs/otel/compatibility/opencensus/`

---

## 5. OpenTracing compatibility (shim)

### Status

**Deprecated** as of **March 2026**; removal not before **March 2027**. Same posture as
OpenCensus above: existing shims MAY continue, new implementation isn't required.
`Source: https://opentelemetry.io/docs/specs/otel/compatibility/opentracing/`

### What it guarantees / span kind & reference mapping

The shim implements the OpenTracing API as a bridge over the OpenTelemetry API/SDK, without
exposing OTel internals to OpenTracing-instrumented code. The part most likely to surface as an
artifact in ingested data: OpenTracing's two **Reference** types (`Child Of`, `Follows From`)
become OpenTelemetry **Links**, with the original reference type preserved as an
**`opentracing.ref_type`** span attribute. Seeing that attribute key in customer traces is a tell
that the data passed through this shim. The first `Child Of` reference (or the first
reference of any kind if none is `Child Of`) is chosen as the span's actual OTel parent; Baggage
from referenced spans is merged into the new span's initial Baggage.

**Known limitation called out by the spec:** mixing the OpenTracing shim and the native
OpenTelemetry API in the same process risks broken Baggage propagation, because OpenTelemetry has
no awareness of the shim's association between a shim span and its Baggage; in languages with
implicit context propagation (e.g. JavaScript) this can also produce incorrect parent/child
relationships, violating OpenTracing's explicit-propagation-only semantics.
`Source: https://opentelemetry.io/docs/specs/otel/compatibility/opentracing/`

---

## 6. Other emerging spec-tree items (pointers)

- **Entities**: a Development-stage remodeling of the Resource concept. Each signal (including
  Profiles) will be able to attach one or more typed Entities (`k8s.cluster`, `host`,
  `container`, …), each with stable identifying attributes plus mutable descriptive attributes,
  layered on top of the existing Resource attribute pool for OTLP 1.x backward compatibility.
  Not otherwise covered in this doc set. Treat it as a future Resource-model change to watch, not
  something to implement against yet.
  `Source: https://opentelemetry.io/docs/specs/otel/entities/data-model/`
- **Trace Context in non-OTLP Log Formats**: a compatibility spec (sibling to OpenCensus/
  OpenTracing/Prometheus above) for propagating trace context through log formats that aren't
  OTLP. Listed as a pointer only; it is linked from the same compatibility index but out of
  scope here.
  `Source: https://opentelemetry.io/docs/specs/otel/compatibility/logging_trace_context/`
- **The Collector itself is not part of the OpenTelemetry specification.** Its docs
  (`https://github.com/open-telemetry/opentelemetry-collector`) describe a reference
  implementation's data flow, processors, and receivers (including the `pprof` receiver and
  Schema Translate Processor mentioned above). Useful for understanding available tooling; none
  of it is spec-mandated or spec-versioned.

---

## Key references

- Profiles data model: https://opentelemetry.io/docs/specs/otel/profiles/
- Profiles concept overview: https://opentelemetry.io/docs/concepts/signals/profiles/
- Profiles proto (v1development): https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/profiles/v1development/profiles.proto
- OTLP spec (endpoint paths, protocol status): https://opentelemetry.io/docs/specs/otlp/
- Spec-wide status summary: https://opentelemetry.io/docs/specs/status/
- Profiles Alpha announcement (2026-03-26): https://opentelemetry.io/blog/2026/profiles-alpha/
- Telemetry schemas: https://opentelemetry.io/docs/specs/otel/schemas/
- Schema file format 1.1.0: https://opentelemetry.io/docs/specs/otel/schemas/file_format_v1.1.0/
- Compatibility index: https://opentelemetry.io/docs/specs/otel/compatibility/
- Prometheus & OpenMetrics compatibility: https://opentelemetry.io/docs/specs/otel/compatibility/prometheus_and_openmetrics/
- OpenCensus compatibility: https://opentelemetry.io/docs/specs/otel/compatibility/opencensus/
- OpenTracing compatibility (shim): https://opentelemetry.io/docs/specs/otel/compatibility/opentracing/
- Trace context in non-OTLP log formats: https://opentelemetry.io/docs/specs/otel/compatibility/logging_trace_context/
- Entities data model: https://opentelemetry.io/docs/specs/otel/entities/data-model/
- Document status definitions (Development/Alpha/Beta/RC/Stable/Deprecated/Unmaintained): https://opentelemetry.io/docs/specs/otel/document-status/
