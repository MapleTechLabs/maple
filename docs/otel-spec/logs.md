# Logs & Events (Data Model, Bridge API & SDK)

This page covers the OpenTelemetry **Logs** specification: the log data model, the Logs API (the
"Bridge API"), the Logs SDK, and the current (2026) direction on **Events** as log-based records
instead of a separate signal. It backs spec-compliance checks and a best-practices skill. Every claim
is sourced from the official specification, or from the OTLP proto for wire-level field names.

## Relevance to Maple

> Maple's Rust ingest gateway (`apps/ingest`) receives OTLP logs and writes them to
> Tinybird/ClickHouse, or forwards them to a collector, depending on `INGEST_WRITE_MODE`. Maple is
> mainly a **consumer/backend** of OTel log data. The parts of this spec that matter most to us:
>
> - **Data model field semantics** ([§2.1](#21-logrecord-fields)): how to interpret `Timestamp` vs
>   `ObservedTimestamp`, `SeverityNumber` vs `SeverityText`, and `Body` as an `AnyValue` when mapping
>   incoming OTLP `LogRecord`s into our ClickHouse schema.
> - **Severity normalization.** Error/warn facets should key off `SeverityNumber` ranges, not
>   `SeverityText`. The spec's display names are upper case (`TRACE`, `DEBUG`, `INFO`, `WARN`,
>   `ERROR`, `FATAL`), unlike span status codes, which Maple writes in Title case (`Ok`/`Error`/`Unset`,
>   see `CLAUDE.md`).
> - **Trace correlation fields** (`TraceId`/`SpanId`/`TraceFlags`). These link a log line to its
>   trace and span in the logs UI. The validity rules below (e.g. `SpanId` implies `TraceId`) matter
>   for defensive parsing of malformed producers.
> - **EventName and the Events direction.** OpenTelemetry is deprecating `Span.AddEvent` in favor of
>   log-based events (see [Events](#5-events)). If Maple ingests or displays "events" as a first-class
>   concept, the wire format is `LogRecord.event_name` (proto field 12), not a separate signal. Our own
>   services should check whether anything that uses span events today should switch to log-based
>   events.
> - **SDK batch/limit env vars.** The ingest gateway already runs a Logs SDK for its own logs
>   (`SdkLoggerProvider` with the `opentelemetry-appender-tracing` bridge, in
>   `apps/ingest/src/main.rs`). The defaults also help when debugging customer data gaps (e.g. "why
>   did 2000 logs arrive in one batch 30s late": see the `OTEL_BLRP_*` defaults below).

---

## 1. Overview

**Stability: the overview page has no single badge.** It links to the Stable Data Model, API, and SDK
(see [Stability summary](#6-stability-summary) below).
Source: https://opentelemetry.io/docs/specs/otel/logs/

Unlike traces and metrics, OpenTelemetry does **not** introduce a new logging API that applications
must adopt wholesale. The logs spec **embraces existing logging libraries** and unifies their output
with traces and metrics along three correlation dimensions:

1. **Temporal correlation.** Logs, traces, and metrics all carry timestamps, the most basic form of
   correlation.
2. **Contextual (execution) correlation.** A `LogRecord` can carry `TraceId`/`SpanId`, so a log line
   is attributable to the request and span that produced it.
3. **Resource correlation.** A `LogRecord` carries the same `Resource` model as traces and metrics
   (e.g. identical `k8s.pod.*` attributes), so a log, trace, and metric from one process describe
   their origin identically.

The page names three ways logs reach OpenTelemetry:

- **Existing/legacy log files**, parsed and enriched by the OpenTelemetry Collector (with or without
  an intermediate agent like FluentBit).
- **Log appenders / bridges**: library-specific glue that hooks an existing logging framework (e.g.
  Log4j, Winston, `slog`) so it emits through the OpenTelemetry data model and injects trace context
  into each record.
- **Direct logging**: new application code emits `LogRecord`s through the Logs API/SDK over OTLP,
  skipping files, parsers, and rotation.

Source: https://opentelemetry.io/docs/specs/otel/logs/

---

## 2. Log Data Model

**Stability: Stable.**
Source: https://opentelemetry.io/docs/specs/otel/logs/data-model/ (spec source:
[`specification/logs/data-model.md`](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/logs/data-model.md))

### 2.1 LogRecord fields

All fields are optional at the data-model level. A valid `LogRecord` may have zero fields populated
(see [§2.4](#24-minimal-validity--missing-fields)). The table gives each field's type, meaning, and the
SHOULD/MUST guidance the spec attaches to it.

| Field                  | Type                                  | Meaning                                                                                                                                                    | Requirement-level notes                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Timestamp`            | `uint64` nanoseconds since Unix epoch | Time the event occurred, per the **origin clock** (the producer's clock, which may be unsynchronized)                                                      | Optional. May be omitted for early instrumentation phases per the spec's incremental-adoption note.                                                                                                                                |
| `ObservedTimestamp`    | `uint64` nanoseconds since Unix epoch | Time the OpenTelemetry collection/observation system (SDK, collector, receiver) **first observed/recorded** the event, e.g. file-read time for tailed logs | SHOULD be set when the event's true origin timestamp is unavailable or untrusted. If unspecified by an SDK's `Emit`, the SDK **SHOULD** set it to current time (see [§4 SDK](#41-logrecord-lifecycle--observedtimestamp-default)). |
| `TraceId`              | byte sequence (16 bytes on the wire)  | W3C Trace Context trace identifier for the request being processed when the log was emitted                                                                | Optional.                                                                                                                                                                                                                          |
| `SpanId`               | byte sequence (8 bytes on the wire)   | Identifier of the specific span being processed when the log was emitted                                                                                   | Optional, but **if `SpanId` is present, `TraceId` SHOULD also be present.**                                                                                                                                                        |
| `TraceFlags`           | 1 byte                                | W3C trace flags (currently only defines the `SAMPLED` bit)                                                                                                 | Optional.                                                                                                                                                                                                                          |
| `SeverityText`         | string                                | The **original**, source-native severity string (e.g. `"WARN"`, `"ERR"`, framework-specific spelling), preserved as-is                                     | Optional.                                                                                                                                                                                                                          |
| `SeverityNumber`       | integer, 0-24                         | The **normalized** severity, mapped onto OpenTelemetry's fixed 1-24 numeric scale (0 = unspecified)                                                        | Optional. See full table in [§2.2](#22-severitynumber-reference-table).                                                                                                                                                            |
| `Body`                 | `AnyValue`                            | The log payload: a human-readable message string, **or** structured data (maps/arrays/scalars)                                                             | Optional. Body **MUST support `AnyValue`** so structured logs from applications survive without lossy stringification.                                                                                                             |
| `Resource`             | `Resource`                            | Describes the entity producing the log (same `Resource` model as traces/metrics)                                                                           | Optional at the data-model layer; in practice always populated by the SDK.                                                                                                                                                         |
| `InstrumentationScope` | `InstrumentationScope`                | The logger (name/version/schema_url/attributes) that emitted the record; stable across many log events from the same source                                | Optional at the data-model layer; populated by the SDK.                                                                                                                                                                            |
| `Attributes`           | collection of key-value pairs         | Additional structured data about this **specific occurrence** (as opposed to `Resource`, which describes the origin)                                       | Optional. Subject to the same attribute limits as spans (count/length limits, see [§4.5](#45-logrecord-limits)).                                                                                                                   |
| `EventName`            | string                                | Identifies the **class/type** of the event this log record represents                                                                                      | Optional. A non-empty `EventName` makes this record an **Event** (see [§5](#5-events)).                                                                                                                                            |

Source: https://opentelemetry.io/docs/specs/otel/logs/data-model/#log-and-event-record-definition

### 2.2 SeverityNumber reference table

The severity scale is a fixed 1-24 integer range in six named bands. Each band has four values
(`+1`..`+3` above the base) for systems whose native severities do not align exactly:

| SeverityNumber | Name            | Meaning                                                                                 |
| -------------- | --------------- | --------------------------------------------------------------------------------------- |
| 0              | _(unspecified)_ | No severity information; `SeverityNumber` omitted/zero.                                 |
| 1              | `TRACE`         | A fine-grained debugging event. Typically disabled by default.                          |
| 2              | `TRACE2`        |                                                                                         |
| 3              | `TRACE3`        |                                                                                         |
| 4              | `TRACE4`        |                                                                                         |
| 5              | `DEBUG`         | A debugging event.                                                                      |
| 6              | `DEBUG2`        |                                                                                         |
| 7              | `DEBUG3`        |                                                                                         |
| 8              | `DEBUG4`        |                                                                                         |
| 9              | `INFO`          | An informational event. Indicates that an event happened.                               |
| 10             | `INFO2`         |                                                                                         |
| 11             | `INFO3`         |                                                                                         |
| 12             | `INFO4`         |                                                                                         |
| 13             | `WARN`          | A warning event. Not an error but is likely more important than an informational event. |
| 14             | `WARN2`         |                                                                                         |
| 15             | `WARN3`         |                                                                                         |
| 16             | `WARN4`         |                                                                                         |
| 17             | `ERROR`         | An error event. Something went wrong.                                                   |
| 18             | `ERROR2`        |                                                                                         |
| 19             | `ERROR3`        |                                                                                         |
| 20             | `ERROR4`        |                                                                                         |
| 21             | `FATAL`         | A fatal error such as an application or system crash.                                   |
| 22             | `FATAL2`        |                                                                                         |
| 23             | `FATAL3`        |                                                                                         |
| 24             | `FATAL4`        |                                                                                         |

Guidance for producers mapping a **source system's own severities** onto this scale:

- If one source severity maps to an OpenTelemetry band (e.g. source "WARN" → the `WARN` band), use
  the **smallest** value in that band (plain `WARN` = 13, not 14-16).
- If a source has **several** severities that fall into one band (e.g. a framework with both "notice"
  and "warning"), spread them across that band's four values (13-16) in order of increasing
  importance, so relative ordering is preserved.
- **`SeverityNumber >= ERROR (17)` signals an erroneous situation.** Backends should use this to
  classify a log line as an error for dashboards and alerts, not string-matching on `SeverityText`.

Source: https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber and
https://opentelemetry.io/docs/specs/otel/logs/data-model/#displaying-severity

### 2.3 Body / AnyValue semantics

`Body` is typed as `AnyValue`, the same recursive value type used for attribute values. It is either a
scalar (string/bool/int/double/bytes) or a structure: an array of `AnyValue`, or a map of string keys
to `AnyValue`. This preserves **structured logging** (e.g. a JSON-object log line) without forcing
lossy stringification into one message field. The data model **MUST** support `AnyValue` for `Body`
because occurrences of a log from the same call site can vary in shape (e.g. conditionally included
fields).

Source: https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-body

### 2.4 Minimal validity / missing fields

The data model mandates no minimum set of populated fields. An empty `LogRecord` is legal, though
useless. Practical guidance:

- **`Timestamp` vs `ObservedTimestamp`**: when a consumer or exporter must reduce a record to one
  timestamp (e.g. exporting to a system with a single time field), **use `Timestamp` if present,
  otherwise `ObservedTimestamp`.** A record with only `ObservedTimestamp` set is valid. It is the
  expected shape for tailed or parsed legacy logs whose origin time is unknown or untrusted.
- **`SpanId` without `TraceId`** is a malformed record to a strict consumer, since the spec says
  `TraceId` SHOULD accompany `SpanId`. The reverse is allowed: a record MAY carry `TraceId` alone
  (e.g. no active span at emit time), and a defensive backend like Maple's ingest path should accept
  it.

Source: https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-observedtimestamp and
https://opentelemetry.io/docs/specs/otel/logs/data-model/#trace-context-fields

### 2.5 Data Model Appendix: mappings from other systems

**Stability: Stable (companion to the data model).**
Source: https://opentelemetry.io/docs/specs/otel/logs/data-model-appendix/

The appendix gives field-by-field mapping tables from common log formats onto the OpenTelemetry
`LogRecord`, useful when writing or auditing a receiver or exporter. Formats covered: RFC 5424 Syslog,
Windows Event Log, SignalFx Events, Splunk HEC, Log4j, Zap, Apache HTTP Server access logs, AWS
CloudTrail, Google Cloud Logging, and the Elastic Common Schema. The pattern is the same for all of
them: native timestamp → `Timestamp`, native severity/level → `SeverityNumber` (+ `SeverityText` for
the original string), free-form message → `Body`, host/service/cloud identity → `Resource`, other
structured fields → `Attributes`. **Appendix B** gives severity equivalence mappings (e.g. Java
`FINEST` → `TRACE`(1); Syslog `Debug` → `DEBUG`(5); Syslog `Emergency` and Log4j `FATAL` →
`FATAL`(21)). It is the authoritative source if Maple needs to normalize a specific framework's
severities at ingest.

Source: https://opentelemetry.io/docs/specs/otel/logs/data-model-appendix/

---

## 3. Logs API ("Bridge API")

**Stability: Stable, except where otherwise specified** (the page calls out an "Ergonomic API" as
still in **Development**).
Source: https://opentelemetry.io/docs/specs/otel/logs/api/ (spec source:
[`specification/logs/api.md`](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/logs/api.md))

### 3.1 Intended audience

The spec calls this the **Logs Bridge API**. It is **not meant for application developers to call
directly** in everyday code. The primary audience:

- **Log appender / bridge authors**, who write the glue that lets an existing logging library (Log4j,
  Winston, `slog`, Python `logging`, etc.) emit through OpenTelemetry.
- Secondarily, instrumentation and instrumented-library authors. They _may_ call it directly, though a
  language may offer a more ergonomic wrapper for that purpose.

For Maple: our services should not call `Logger.Emit` by hand. They should use a logging-library
bridge or the language's ergonomic wrapper. The ingest gateway already does this through the Rust
`tracing` bridge (`OpenTelemetryTracingBridge` in `apps/ingest/src/main.rs`).

Source: https://opentelemetry.io/docs/specs/otel/logs/api/#overview

### 3.2 LoggerProvider

Entry point. It **MUST** provide a "Get a Logger" operation, parameterized by the **Instrumentation
Scope**: `name` (required), `version` (optional), `schema_url` (optional), `attributes` (optional). It
must also support access to a global default `LoggerProvider`.

Source: https://opentelemetry.io/docs/specs/otel/logs/api/#loggerprovider

### 3.3 Logger: Emit a LogRecord

The `Logger` interface's core operation accepts (all optional except where noted):

- `Timestamp`, `ObservedTimestamp`
- `Context`: **"When implicit Context is supported, then this parameter SHOULD be optional and if
  unspecified then MUST use current Context. When only explicit Context is supported, this
  parameter SHOULD be required."** This is how trace correlation gets attached automatically. At emit
  time the SDK reads the active span out of the `Context` in scope (implicit or explicitly passed) and
  copies its `TraceId`/`SpanId`/`TraceFlags` onto the record.
- `SeverityNumber`, `SeverityText`
- `Body`
- `Attributes`
- `EventName`
- `Exception`: optional; MAY be accepted as a convenience for exception recording

### 3.4 Enabled

`Logger` **SHOULD** provide an `Enabled(context, severityNumber, eventName)` operation returning a
boolean, so callers can skip expensive log construction when the record would be dropped. The spec
notes the result "is not always static, it can change over time" (e.g. dynamic sampling or config), so
callers should call it each time instead of caching the result.

### 3.5 Concurrency

For both `LoggerProvider` and `Logger`, **all methods MUST be documented as safe for concurrent use by
default.**

Source (3.2-3.5): https://opentelemetry.io/docs/specs/otel/logs/api/

---

## 4. Logs SDK

**Stability: Stable, except where otherwise specified.** The page marks these as Development:
**`LoggerConfigurator`, per-`LoggerConfig` behavior (`enabled`/`minimum_severity`/`trace_based`),
`Enabled`-based filtering rules, and the "Event to span event bridge processor".**
Source: https://opentelemetry.io/docs/specs/otel/logs/sdk/ (spec source:
[`specification/logs/sdk.md`](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/logs/sdk.md))

### 4.1 LogRecord lifecycle / ObservedTimestamp default

The SDK-level `Emit` operation implements the data-model rule from
[§2.4](#24-minimal-validity--missing-fields): **"If Observed Timestamp is unspecified, the
implementation SHOULD set it equal to the current time."** This is the SDK-side guarantee behind the
data model's "SHOULD be set" language for `ObservedTimestamp`.

### 4.2 LoggerProvider / Logger (SDK)

- A `LoggerProvider` **MUST** provide a way to configure and attach a `Resource`.
- It owns the registered `LogRecordProcessor`s and (Development) a `LoggerConfigurator`.
- Multiple independent `LoggerProvider` instances may exist in one process.
- **Shutdown**: called once; the SDK should make the `Logger` a no-op after shutdown.
- **ForceFlush**: tells all registered processors to flush pending records.
- `LoggerConfig` (Development) parameters, per logger: `enabled` (default `true`),
  `minimum_severity` (default `0`, filters records below this `SeverityNumber`), `trace_based`
  (default `false`; when `true`, drops records for unsampled traces).

### 4.3 LogRecordProcessor

Interface operations:

- **OnEmit**: called synchronously on the emitting thread with a `ReadWriteLogRecord` and the
  resolved `Context`. It **SHOULD NOT block or throw**.
- **Enabled** (optional): filtering hook taking context, instrumentation scope, severity, and event
  name; returns bool.
- **Shutdown**, **ForceFlush**: as for other OTel pipeline components.

#### Simple Processor

Passes each finished `LogRecord` to its configured `exporter` **immediately**, synchronized so
`Export` is never called concurrently on the same exporter instance.

#### Batching Processor

Buffers records into batches before handing them to the exporter. Parameters and **their environment
variables** (general SDK env var spec):

| Parameter             | Env var                           | Default      | Notes                                                |
| --------------------- | --------------------------------- | ------------ | ---------------------------------------------------- |
| Max queue size        | `OTEL_BLRP_MAX_QUEUE_SIZE`        | `2048`       | Maximum number of `LogRecord`s buffered before drop. |
| Scheduled delay       | `OTEL_BLRP_SCHEDULE_DELAY`        | `1000` (ms)  | Delay between consecutive batch exports.             |
| Export timeout        | `OTEL_BLRP_EXPORT_TIMEOUT`        | `30000` (ms) | Max time allowed for a single export call.           |
| Max export batch size | `OTEL_BLRP_MAX_EXPORT_BATCH_SIZE` | `512`        | Must be `<=` max queue size.                         |

All numeric values must be positive. `BLRP` stands for **B**atch **L**og**R**ecord **P**rocessor,
the same naming pattern as `BSP` for spans.

Source: https://opentelemetry.io/docs/specs/otel/logs/sdk/#batching-processor and
https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/configuration/sdk-environment-variables.md
(§ "Batch LogRecord Processor")

### 4.4 LogRecordExporter

- **Export(batch of `ReadableLogRecord`s)** → `Success` | `Failure`. **Must not be called
  concurrently** with other `Export` calls on the same exporter instance (the processor serializes
  calls).
- **ForceFlush**: completes pending exports within a timeout.
- **Shutdown**: releases resources; any later `Export` call **MUST** return `Failure`.

Source: https://opentelemetry.io/docs/specs/otel/logs/sdk/#logrecordexporter

### 4.5 LogRecord limits

The SDK applies the same family of attribute limits used for spans to `LogRecord.Attributes`:

| Parameter                    | Env var                                       | Default  | Notes                                                                                                                       |
| ---------------------------- | --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| Attribute count limit        | `OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT`        | `128`    | Non-negative integer; extra attributes past this count are dropped (and counted in `dropped_attributes_count` on the wire). |
| Attribute value length limit | `OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT` | no limit | Non-negative integer; truncates attribute values longer than this.                                                          |

Source: https://opentelemetry.io/docs/specs/otel/logs/sdk/#logrecord-limits and
https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/configuration/sdk-environment-variables.md
(§ "Attribute Limits" / "LogRecord Limits")

### 4.6 Exporter selection

| Env var              | Default | Known values                                                                                                                                                             |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OTEL_LOGS_EXPORTER` | `otlp`  | `otlp`, `console`, `logging` (deprecated alias for `console`), `none`. Implementations may accept a comma-separated list to configure multiple exporters simultaneously. |

Source: https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/configuration/sdk-environment-variables.md
(§ "Exporter Selection")

### 4.7 Concurrency

- `LoggerProvider`: creating `Logger`s, `ForceFlush`, and `Shutdown` must be thread-safe.
- `Logger`: all methods thread-safe.
- `LogRecordExporter`: `ForceFlush`/`Shutdown` thread-safe. `Export` is explicitly **not** required
  to be safe against concurrent calls to itself; the processor serializes them.

Source: https://opentelemetry.io/docs/specs/otel/logs/sdk/#concurrency-requirements

---

## 5. Events

**Stability: Development, changing actively (2026).** This is the part of the spec most in flux. This
section reflects the _current_ normative direction, not a settled long-term API.

### 5.1 Current model: Events are log records, not a separate signal

The current spec has **no separate Event API/SDK**. The historical `specification/logs/event-api.md`
(a standalone Event API layered on the Logs API, present in older versions such as
[v1.35.0](https://github.com/open-telemetry/opentelemetry-specification/blob/v1.35.0/specification/logs/event-api.md))
**no longer exists on `main`** (confirmed 404 against the `main` tree at time of writing). Events are
folded into the log data model:

- An **Event** is **a `LogRecord` with a non-empty `EventName`**, not a distinct message type. On the
  wire it is `LogRecord.event_name` (field 12, `opentelemetry/proto/logs/v1/logs.proto`), next to
  `time_unix_nano`, `severity_number`, `body`, `attributes`, `trace_id`, `span_id`, etc. There is no
  `EventRecord` proto message.
- All Events sharing an `EventName` **MUST** conform to the same schema for both `Attributes` and
  `Body`. `EventName` acts as a schema/type discriminator.
- Per the events semantic-conventions page, Events **MUST** set `Timestamp` to when the event
  occurred, and semantic conventions **MUST NOT** define a value for `ObservedTimestamp`. That field
  stays about when the pipeline observed the record; the SDK or collector fills it.
- Event semantic conventions **MUST NOT** define a `Body` value except a plain string display message.
  Structured, queryable data belongs in `Attributes`, preferably flat.
- Event semantic conventions **MUST** document the event name, so querying by `event.name` returns
  records that conform to that convention's schema.

Source: https://opentelemetry.io/docs/specs/semconv/general/events/ and
https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-eventname

### 5.2 Deprecation of Span Events in favor of log-based events

An in-progress spec direction, tracked as an accepted OTEP (referenced as **OTEP 4430** in the
announcement): OpenTelemetry is **deprecating the Span Events API** (`Span.AddEvent()` and
`Span.RecordException()`). Instrumentation should emit **log-based events** through the Logs API/SDK
instead, correlated to the active trace and span via `Context` (the mechanism in
[§3.3](#33-logger-emit-a-logrecord)) instead of being attached to the span object.

Stated rationale: two overlapping event mechanisms gave library authors inconsistent guidance, gave
operators duplicate concepts to learn, and slowed spec work because every improvement had to be
designed and implemented twice.

Migration posture (the source gives no exact version or date commitments):

- New instrumentation should prefer log-based events **now**.
- Existing instrumentation's current major version stays compatible (no breaking removal yet).
- Next major versions of instrumentation libraries and semantic conventions are expected to move from
  span events to log-based events.
- Language SDKs are expected to offer compatibility shims during the transition.

**Practical implication for Maple:** if our self-instrumentation (or instrumentation we depend on)
uses `span.addEvent(...)`, e.g. for exception recording, expect upstream libraries to move that data
into log-based Events (`LogRecord` with `EventName` set). Our ingest path handles both shapes, since
both arrive as normal OTLP: span events inside `Span.events`, log-based events in the Logs stream.
Dashboard logic that reads "events" **only** from `Span.events` will miss log-based events, and vice
versa, until the ecosystem finishes migrating.

Source: https://opentelemetry.io/blog/2026/deprecating-span-events/

---

## 6. Stability summary

| Area                                            | Stability (as stated by spec)                                                                                             | Source                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs Data Model                                 | Stable                                                                                                                    | https://opentelemetry.io/docs/specs/otel/logs/data-model/                                                                                                               |
| Data Model Appendix (mappings)                  | Stable                                                                                                                    | https://opentelemetry.io/docs/specs/otel/logs/data-model-appendix/                                                                                                      |
| Logs API ("Bridge API")                         | Stable, except Ergonomic API (Development)                                                                                | https://opentelemetry.io/docs/specs/otel/logs/api/                                                                                                                      |
| Logs SDK                                        | Stable, except `LoggerConfigurator`/`LoggerConfig`/`Enabled`-filtering/event-to-span-event-bridge processor (Development) | https://opentelemetry.io/docs/specs/otel/logs/sdk/                                                                                                                      |
| OTLP Logs wire format (`logs.proto`)            | Stable (part of OTLP)                                                                                                     | https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto                                                                  |
| Events (semantic-convention layer, `EventName`) | **Development**                                                                                                           | https://opentelemetry.io/docs/specs/semconv/general/events/                                                                                                             |
| Span Events API (`Span.AddEvent`)               | **Deprecated** (transition to log-based events in progress)                                                               | https://opentelemetry.io/blog/2026/deprecating-span-events/                                                                                                             |
| Standalone Event API/SDK (`logs/event-api.md`)  | **Removed**; folded into Logs Data Model / API                                                                            | (confirmed absent on `main`; last present at tag [v1.35.0](https://github.com/open-telemetry/opentelemetry-specification/blob/v1.35.0/specification/logs/event-api.md)) |

---

## Key references

- Logs specification overview: https://opentelemetry.io/docs/specs/otel/logs/
- Logs Data Model: https://opentelemetry.io/docs/specs/otel/logs/data-model/
- Data Model Appendix (format mappings): https://opentelemetry.io/docs/specs/otel/logs/data-model-appendix/
- Logs API (Bridge API): https://opentelemetry.io/docs/specs/otel/logs/api/
- Logs SDK: https://opentelemetry.io/docs/specs/otel/logs/sdk/
- SDK environment variables (Batch LogRecord Processor, LogRecord Limits, `OTEL_LOGS_EXPORTER`): https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/configuration/sdk-environment-variables.md
- Events semantic conventions (general): https://opentelemetry.io/docs/specs/semconv/general/events/
- Deprecating Span Events API (blog, 2026): https://opentelemetry.io/blog/2026/deprecating-span-events/
- OTLP `logs.proto` (wire format, `LogRecord`/`SeverityNumber`/`ResourceLogs`/`ScopeLogs`): https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/logs/v1/logs.proto
- Specification status summary: https://opentelemetry.io/docs/specs/status/
- Historical Event API (v1.35.0 snapshot, context only, not current): https://github.com/open-telemetry/opentelemetry-specification/blob/v1.35.0/specification/logs/event-api.md
