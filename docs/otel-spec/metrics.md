# Metrics (API, SDK & Data Model)

A compliance reference for the OpenTelemetry **Metrics** signal. It covers the client-facing **API**
(instrument creation and recording), the **SDK** (Views, Aggregations, MetricReader/Exporter config),
and the **Data Model** that defines what goes over OTLP (point kinds, temporality, exemplars, resets).
It backs spec-compliance checks and a best-practices skill. Every claim is sourced from the fetched
spec pages, not from memory.

> Source pages fetched for this document:
>
> - API: https://opentelemetry.io/docs/specs/otel/metrics/api/
> - SDK: https://opentelemetry.io/docs/specs/otel/metrics/sdk/
> - Data model: https://opentelemetry.io/docs/specs/otel/metrics/data-model/
> - Overview: https://opentelemetry.io/docs/specs/otel/metrics/
> - OTLP exporter env vars: https://opentelemetry.io/docs/specs/otel/metrics/sdk_exporters/otlp/
> - General SDK env vars: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
> - Canonical repo (raw): `specification/metrics/data-model.md`, `specification/metrics/sdk.md` on
>   [open-telemetry/opentelemetry-specification](https://github.com/open-telemetry/opentelemetry-specification)

## Relevance to Maple

Maple is mainly a **consumer/backend** for OTel metrics. The Rust ingest gateway (`apps/ingest`)
writes OTLP metric points to Tinybird/ClickHouse, or forwards them to a collector, depending on
`INGEST_WRITE_MODE`. The gateway also self-instruments: its own OTLP metrics are defined in
`apps/ingest/src/metrics.rs`. The parts of this spec that matter most to us:

- **Data model correctness** when ingesting and storing OTLP metric points: point kinds, temporality
  (delta vs cumulative), `start_time_unix_nano` semantics for reset/gap detection, and the
  `NoRecordedValue` staleness flag. These decide how we aggregate and query stored metrics.
- **Single-writer principle and overlap handling.** As a backend we are a "receiver" in the spec's
  terms. The normative guidance on deduplicating overlapping streams and detecting resets applies to
  any rollup or materialized-view logic we build over ingested metrics.
- **Exponential histograms.** We may need to render or aggregate these (scale/bucket mapping), so the
  mapping function is captured at a working level.
- **Summary points** are dropped at encode time today (`metrics_summary_dropped` in
  `apps/ingest/src/telemetry.rs`); there is no Summary datasource.
- **OTLP exporter env vars** (temporality preference, default histogram aggregation). Relevant when
  documenting how instrumented clients should send to our ingest gateway, and for our own
  self-instrumentation config.
- Metrics have a product surface (`/metrics`), but exemplars and histogram distributions are stored and
  never shown (see `docs/otel-coverage-roadmap.md`). SDK-side View/aggregation config is lower
  priority than data-model fidelity. It is included because spec-compliance checks may need to
  validate producer behavior.

---

## 1. Metrics API

**Stability: Stable**, except where individually marked _(Development)_ below (for example the
`Attributes` advisory parameter).
Source: https://opentelemetry.io/docs/specs/otel/metrics/api/

### 1.1 Core architecture

| Concept         | Role                                                                                                                                              | Source anchor    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `MeterProvider` | Entry point; owns config (exporters, readers, views). "The API SHOULD provide a way to set/register and access a global default `MeterProvider`." | `#meterprovider` |
| `Meter`         | Created from a `MeterProvider`; "Responsible for creating `Instruments`." Meter MUST NOT hold configuration; that is the MeterProvider's job.     | `#meter`         |
| `Instrument`    | Identified by `name`, `kind`, `unit`, `description` (plus language-level value-type distinction, e.g. integer vs floating point)                  | `#instrument`    |

`Meter` creation parameters (`Get a Meter`):

- `name` (required): instrumentation scope name, e.g. `io.opentelemetry.contrib.mongodb`
- `version` (optional): e.g. `1.0.0`
- `schema_url` (optional, since spec v1.4.0)
- instrumentation scope `attributes` (optional, since spec v1.13.0)

Source: https://opentelemetry.io/docs/specs/otel/metrics/api/#meter

### 1.2 Instruments

All instruments are namespaced under a `Meter`. There "MUST NOT be any API for creating [an
instrument] other than with Meter" (normative MUST): no free-standing instrument construction.

#### Synchronous instruments

| Instrument        | Semantics                                                         | Monotonic?           | Recording op                                | Valid values                                                                                                       |
| ----------------- | ----------------------------------------------------------------- | -------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Counter**       | Non-negative increments                                           | Yes (non-decreasing) | `Add(value, attributes)`                    | Non-negative; API "SHOULD be documented" as non-negative but "SHOULD NOT validate"                                 |
| **UpDownCounter** | Increments and decrements                                         | No                   | `Add(value, attributes)` (accepts negative) | Any; used "when the absolute values are not pre-calculated, or fetching the 'current value' requires extra effort" |
| **Histogram**     | Arbitrary, statistically-meaningful values                        | N/A                  | `Record(value, attributes)`                 | Non-negative (documented, not validated); advisory `ExplicitBucketBoundaries: double[]` _(Stable)_                 |
| **Gauge**         | Non-additive value(s), recorded via subscription to change events | N/A                  | `Record(value, attributes)`                 | Absolute current value at time of recording                                                                        |

Source: https://opentelemetry.io/docs/specs/otel/metrics/api/#counter ,
`#updowncounter`, `#histogram`, `#gauge`

#### Asynchronous (observable) instruments

All use **callback functions**, registered at creation or afterward, "called only when the Meter is
being observed."

| Instrument                     | Semantics                          | Monotonic? | Value reported                                                                  |
| ------------------------------ | ---------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| **Asynchronous Counter**       | Monotonically increasing           | Yes        | Absolute (not delta); SDK derives rate from successive differences              |
| **Asynchronous UpDownCounter** | Additive, can increase or decrease | No         | Absolute; SDK calculates deltas                                                 |
| **Asynchronous Gauge**         | Non-additive                       | N/A        | Absolute, from an accessor/poll (contrast with sync Gauge's subscription model) |

Callback normative requirements:

- "Callback functions SHOULD be reentrant safe"
- "SHOULD NOT take an indefinite amount of time"
- "SHOULD NOT make duplicate observations across all registered callbacks"
- Observations from a single callback invocation "MUST be reported with identical timestamps"
- API "SHOULD support registration of `callback` functions after asynchronous instrumentation creation";
  the user "MUST be able to undo registration ... by some means"

Source: https://opentelemetry.io/docs/specs/otel/metrics/api/#asynchronous-instrument-api ,
`#asynchronous-counter`, `#asynchronous-updowncounter`, `#asynchronous-gauge`

### 1.3 Instruments × default aggregation (cross-reference to SDK §2.2)

See the table in [§2.2](#22-aggregations--default-per-instrument). The API does not define
aggregation, but readers need the pairing.

### 1.4 Naming rules

**Instrument name syntax.** Source: https://opentelemetry.io/docs/specs/otel/metrics/api/#instrument-name-syntax

```
instrument-name = ALPHA 0*254 ("_" / "." / "-" / "/" / ALPHA / DIGIT)
```

- Not null/empty; case-insensitive ASCII
- First character: alphabetic (A-Z, a-z)
- Subsequent characters: alphanumeric, `_`, `.`, `-`, `/`
- **Max length: 255 characters**
- "The API SHOULD NOT validate the `name`; that is left to implementations."

**Unit.** Source: `#instrument-unit`

- Case-sensitive ASCII string, opaque
- **Max length: 63 characters** (chosen to allow fixed-size array storage)
- "The API SHOULD NOT validate the `unit`"

**Description.** Source: `#instrument-description`

- Must support BMP (Unicode Plane 0); minimum guaranteed support **1023 characters**
- Opaque string

### 1.5 Instrument identity, duplicate registration, and concurrency

- **Identical instruments**: all identifying parameters equal (name, kind, unit, description, and the
  language-level value-type distinction).
- **Distinct instruments**: differ in at least one identifying parameter.
- The Metrics **API spec does not define behavior for duplicate or conflicting registration**. That is
  left to the SDK. (Data Model §3.6 below covers the normative handling of conflicting `Metric`
  identities once they reach OTLP.)
- **Concurrency**: for `MeterProvider`, `Meter`, and `Instrument`, "All methods MUST be documented that
  implementations need to be safe for concurrent use by default."

Source: https://opentelemetry.io/docs/specs/otel/metrics/api/#concurrency-requirements

### 1.6 Attributes

"Users can provide attributes to associate with ... values, but it is up to their discretion. Therefore,
this API MUST be structured to accept a variable number of attributes, including none." For multiple
observations in one async callback: "User code is recommended not to provide more than one `Measurement`
with the same `attributes` in a single callback."

Source: https://opentelemetry.io/docs/specs/otel/metrics/api/#measurement

---

## 2. Metrics SDK

**Stability: Mixed.** Most areas below are Stable; a few are explicitly Development (noted inline).
Source: https://opentelemetry.io/docs/specs/otel/metrics/sdk/

### 2.1 Views

Views let the SDK owner change how instruments become metric streams without touching instrumentation
code.

**Instrument selection criteria** (all optional; user picks any subset):

| Criterion                                         | Matching                                                        |
| ------------------------------------------------- | --------------------------------------------------------------- |
| `name`                                            | Exact match or wildcard (`*` = any sequence, `?` = single char) |
| `type`                                            | Instrument kind                                                 |
| `unit`                                            | Exact unit value                                                |
| `meter_name`, `meter_version`, `meter_schema_url` | Meter identity metadata                                         |

**Stream configuration** applied to matched instruments:

| Parameter                       | Effect                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`                          | Override output stream name (not re-validated against instrument-name syntax)                                          |
| `description`                   | Override description                                                                                                   |
| `attribute_keys`                | Allow-list/exclude-list of attribute keys; View takes precedence over the instrument's `Attributes` advisory parameter |
| `aggregation`                   | Override the default aggregation (see §2.2)                                                                            |
| `exemplar_reservoir`            | Custom exemplar sampling strategy                                                                                      |
| `aggregation_cardinality_limit` | Max data points emitted per collection cycle for this stream                                                           |

Source: https://opentelemetry.io/docs/specs/otel/metrics/sdk/#instrument-selection-criteria ,
`#stream-configuration`

### 2.2 Aggregations: default per instrument

| Instrument                                | Default aggregation                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| Counter, Asynchronous Counter             | Sum                                                                                   |
| UpDownCounter, Asynchronous UpDownCounter | Sum                                                                                   |
| Gauge, Asynchronous Gauge                 | Last Value                                                                            |
| Histogram                                 | Explicit Bucket Histogram (honoring the `ExplicitBucketBoundaries` advisory if given) |

**Explicit Bucket Histogram** _(Stable)_ default boundaries:

```
[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]
```

`RecordMinMax` defaults to `true`.

**Base2 Exponential Histogram** _(recommended default config when this aggregation is selected)_:
`MaxSize = 160` buckets, `MaxScale = 20`, `RecordMinMax = true`.

**Drop aggregation**: discards all measurements for the instrument (emits nothing).

Source: https://opentelemetry.io/docs/specs/otel/metrics/sdk/#aggregation ,
raw spec `specification/metrics/sdk.md` (boundary list and MaxSize/MaxScale defaults confirmed verbatim).

### 2.3 MetricReader / MetricExporter

**Periodic Exporting MetricReader** _(Stable)_:

- Collects at a configurable interval, default **60,000 ms**
- Export timeout, default **30,000 ms**
- _(Development)_ `maxExportBatchSize` splits large batches while preserving order across collections

**Collect operation**: triggers async-instrument callbacks, invokes `Produce` on registered
`MetricProducer`s, and applies the configured aggregation temporality (converting delta↔cumulative for
synchronous instruments as needed).

Source: https://opentelemetry.io/docs/specs/otel/metrics/sdk/#metricreader-operations ,
`#periodic-exporting-metricreader`

### 2.4 Exemplars (SDK side)

**ExemplarFilter** _(Stable)_:

| Filter                 | Behavior                                                |
| ---------------------- | ------------------------------------------------------- |
| `TraceBased` (default) | Eligible only if recorded within a sampled span context |
| `AlwaysOn`             | All measurements eligible                               |
| `AlwaysOff`            | No measurements eligible                                |

**ExemplarReservoir** _(Stable)_: one per timeseries. `Offer(value, attributes, context, timestamp)`
adds a candidate; `Collect()` returns accumulated exemplars respecting the stream's aggregation
temporality.

Default reservoir selection:

| Aggregation                           | Default reservoir                                                  |
| ------------------------------------- | ------------------------------------------------------------------ |
| Explicit bucket histogram (>1 bucket) | `AlignedHistogramBucketExemplarReservoir`                          |
| Exponential histogram                 | `SimpleFixedSizeExemplarReservoir` (size = `min(20, max_buckets)`) |
| Everything else                       | `SimpleFixedSizeExemplarReservoir`                                 |

Source: https://opentelemetry.io/docs/specs/otel/metrics/sdk/#exemplar

### 2.5 Cardinality limits

**Status: Stable.**

- Enforced **after** attribute filtering (after the View's `attribute_keys` allow/exclude list is
  applied).
- Resolution order: (1) View's `aggregation_cardinality_limit`, then (2) MetricReader default for that
  instrument kind, then (3) **global default of 2000**.
- **Overflow attribute**: measurements beyond the limit are aggregated into one synthetic series tagged
  `otel.metric.overflow = true` (boolean).
- **Cumulative streams**: "continue to export all attribute sets that were observed prior to the
  beginning of overflow". Pre-overflow series are kept individually.
- **Delta streams**: "MAY choose an arbitrary subset of attribute sets to output to maintain the stated
  cardinality limit". Which series survive is not stable.
- **Asynchronous instruments**: prefer first-observed attribute sets when trimming.

The general SDK environment-variables page defines **no global env var** for the default cardinality
limit. Only the View-level `aggregation_cardinality_limit` stream parameter and the built-in 2000
default are spec-defined. Language SDKs may expose their own env var; check per-SDK docs before
treating any name as normative.

Source: raw spec `specification/metrics/sdk.md` (Cardinality limits section; the file header says
"Mixed", and the rendered site marks this subsection Stable).

### 2.6 MeterProvider / MeterConfigurator (Development)

_(Development)_ `MeterConfigurator`: a function computing `MeterConfig` from an `InstrumentationScope`.
It returns either a configuration or a signal to use defaults. SDKs may provide helpers for common
patterns (e.g., select meters by name, disable specific meters).
_(Development)_ `MeterConfig`: `enabled: boolean` (default `true`); disabled meters behave as no-ops.

Source: https://opentelemetry.io/docs/specs/otel/metrics/sdk/#meterprovider

---

## 3. Metrics Data Model

**Stability: Stable** for all point kinds, temporality, exemplars, data point flags, and the
single-writer principle. **Development** for the "Resets and Gaps" mechanics and the
"Overlap"/out-of-order handling sections (noted inline below).
Source: https://opentelemetry.io/docs/specs/otel/metrics/data-model/

### 3.1 Point kinds

| Point kind               | Temporality?                     | Key fields                                                                                                                          | Status                                                                                                  |
| ------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Sum**                  | delta or cumulative              | attributes, `(start, end]` window, `monotonic: bool`, exemplars, flags                                                              | Stable                                                                                                  |
| **Gauge**                | n/a (no aggregation temporality) | attributes, sampled value, `time_unix_nano`, optional `start_time_unix_nano`, exemplars, flags                                      | Stable                                                                                                  |
| **Histogram**            | delta or cumulative              | attributes, window, `count`, `sum`, optional `min`/`max`, explicit bucket boundaries + per-bucket counts, exemplars, flags          | Stable                                                                                                  |
| **ExponentialHistogram** | delta or cumulative              | same as Histogram but exponential bucket structure (`scale`, `zero_count`, `zero_threshold`, positive/negative bucket index ranges) | Stable                                                                                                  |
| **Summary (legacy)**     | n/a                              | attributes, `time_unix_nano`, `count`, `sum`, strictly-increasing quantile set `[0.0, 1.0]`                                         | Stable, but "not recommended for new applications"; points "cannot always be merged in a meaningful way" |

**Sum monotonicity**: "Delta monotonic: reader SHOULD expect non-negative values" / "Cumulative
monotonic: reader SHOULD expect values that are not less than the previous value."

**Histogram bucket inclusivity** (normative): "Bucket upper-bounds are inclusive (except for the case
where the upper-bound is +Inf) while bucket lower-bounds are exclusive. That is, buckets express the
number of values that are greater than their lower bound and less than or equal to their upper bound."

**Gauge semantics**: "a point within a Gauge stream represents the last-sampled event for a given time
window". There is no aggregation semantic; the last sample wins when temporally aligning or resampling.

Source: https://opentelemetry.io/docs/specs/otel/metrics/data-model/#sums , `#gauge`, `#histogram`,
`#exponentialhistogram`, `#summary-legacy`

### 3.2 Temporality: delta vs cumulative

|                          | Delta                                                                                                         | Cumulative                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start timestamp behavior | "successive data points **advance** the starting timestamp": `(T0,T1], (T1,T2], (T2,T3]`                      | "successive data points **repeat** the starting timestamp": `(T0,T1], (T0,T2], (T0,T3]`                                                                 |
| Typical origin           | Statsd-style metrics; "enables sampling and supports shifting the cost of cardinality outside of the process" | Prometheus-style; "naturally simpler ... in terms of cost of adding reliability. When collection fails intermittently, gaps ... are naturally averaged" |
| Sender-side memory cost  | Lower (no need to remember all-time totals)                                                                   | Higher: sender must retain "all previous measurements, an 'up-front' memory cost proportional to cardinality"                                           |
| Validity rule            | Intervals must be contiguous: no gaps or overlaps in a well-formed stream                                     | Repeats the same start; validity tracked via reset detection (§3.3)                                                                                     |

Source: https://opentelemetry.io/docs/specs/otel/metrics/data-model/#temporality

**OTLP exporter default and env var** (a producer-side preference, not the wire temporality itself;
see §5.2 for the table): `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`, default `cumulative`.

### 3.3 `start_time_unix_nano`, resets, and gaps

_(Status: Development for this subsection's mechanics.)_
Source: https://opentelemetry.io/docs/specs/otel/metrics/data-model/#resets-and-gaps

> "When the `StartTimeUnixNano` field is present, it allows the consumer to observe when there are gaps
> and overlapping writers in a stream. Correctly used, the consumer can observe both transient and
> ongoing violations of the single-writer principle as well as reset events."

| Case                                   | Condition                           | Meaning                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **True reset (known start)**           | `StartTimeUnixNano < TimeUnixNano`  | "a new unbroken sequence of observations begins with a 'true' reset at a known start time. The zero value is implicit, it is not necessary to record the starting point." |
| **Reset, unknown start**               | `StartTimeUnixNano == TimeUnixNano` | "a new unbroken sequence of observations begins with a reset at an unknown start time. The initial observed value is recorded ... These points have zero duration."       |
| **Subsequent point, delta**            | n/a                                 | `StartTimeUnixNano` of each point matches the `TimeUnixNano` of the _preceding_ point                                                                                     |
| **Subsequent point, cumulative/other** | n/a                                 | `StartTimeUnixNano` of each point matches the `StartTimeUnixNano` of the _initial_ observation in the sequence                                                            |

**Gap definition**: "A metric stream has a gap, where it is implicitly undefined, anywhere there is a
range of time such that no point covers that range with its `StartTimeUnixNano` and `TimeUnixNano`
fields."

### 3.4 Exemplars

**Status: Stable.** Source: https://opentelemetry.io/docs/specs/otel/metrics/data-model/#exemplars

Fields:

| Field                 | Description                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trace_id` (optional) | Trace associated with the recording                                                                                                                                  |
| `span_id` (optional)  | Span associated with the recording                                                                                                                                   |
| `time_unix_nano`      | Time of the observation                                                                                                                                              |
| `value`               | The recorded value                                                                                                                                                   |
| `filtered_attributes` | Attributes present on the measurement but filtered out of the point's own attribute set; they "provide additional insight into the Context when the observation was made" |

Value participation in the parent point:

- **Histogram**: exemplar's value "already participates in `bucket_counts`, `count` and `sum`"
- **Sum**: exemplar's value "is already included in the overall sum"
- **Gauge**: exemplar's value "was seen at some point within the gauge interval for the same source"

### 3.5 Data point flags: staleness marker

**Status: Stable.** Source: https://opentelemetry.io/docs/specs/otel/metrics/data-model/#data-point-flags

**`NoRecordedValue`** flag (default `false`):

> "this data point reflects explicitly missing data in a series. It serves as an indicator that a
> previously present timeseries was removed and that this timeseries SHOULD NOT be returned in queries
> after such an indicator was received."

Equivalent to the [Prometheus staleness marker](https://prometheus.io/docs/prometheus/latest/querying/basics/#staleness).
When set: "all other data point properties except attributes, time stamps, or time windows, SHOULD be
ignored."

### 3.6 Single-writer principle and conflicting metric identities

**Status: Stable.** Source: https://opentelemetry.io/docs/specs/otel/metrics/data-model/#single-writer

> "All metric data streams within OTLP MUST have one logical writer. This means, conceptually, that any
> Timeseries created from the Protocol MUST have one originating source of truth."

- "All metric data streams produced by OTel SDKs SHOULD have globally unique identity at any given point
  in time."
- "Aggregations of metric streams MUST only be written from a single logical source at any given point
  time. **Note: This implies aggregated metric streams must reach one destination**."
- "Multiple writers for a metric stream is considered an error state, or misbehaving system. Receivers
  SHOULD presume a single writer was intended and eliminate overlap / deduplicate."
- Single-writer violations are usually **misconfiguration**, fixable by differentiating `Resource` or
  ensuring non-overlapping time ranges. Semantic errors are a separate class, sometimes fixable via
  Views.

**Conflicting `Metric` identity** for the same `name` + `Resource` + `Scope`. Producer recommendations
_(Stable)_, source: `#opentelemetry-protocol-data-model-producer-recommendations`:

| Conflict                                           | Producer recommendation                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Non-identifying field differs (e.g. `description`) | "producer SHOULD choose the longer string"                                                                           |
| `unit` mismatch (e.g. `ms` vs `s`)                 | MAY convert units to avoid a semantic error; otherwise SHOULD inform the user of a semantic error                    |
| `AggregationTemporality` conflict                  | MAY convert via Cumulative→Delta or Delta→Cumulative transform; otherwise SHOULD inform the user of a semantic error |
| Other identifying-property conflict                | SHOULD inform the user of a semantic error and pass through the conflicting data                                     |

"Consumers MAY reject OpenTelemetry Metrics data containing semantic errors (i.e., more than one
`Metric` identity for a given `name`, `Resource`, and `Scope`)." **Relevant to Maple as an ingest
consumer**: we are within spec to reject or flag such payloads instead of silently merging them.

### 3.7 Overlap and out-of-order handling

_(Status: Development for this subsection.)_
Source: https://opentelemetry.io/docs/specs/otel/metrics/data-model/#overlap

- "When more than one process writes the same metric data stream, OTLP data points may appear to
  overlap. This condition typically results from misconfiguration ... When there are overlapping points,
  receivers SHOULD eliminate points so that there are no overlaps. Which data to select in overlapping
  cases is not specified."
- "OpenTelemetry collectors SHOULD export telemetry when they observe overlapping points in data
  streams, so that the user can monitor for erroneous configurations."
- Expected-overlap interpolation: "When one process starts just as another exits, the appearance of
  overlapping points may be expected ... collectors SHOULD modify points at the change-over using
  interpolation for Sum data points, to reduce gaps to zero width in these cases, without any overlap."

**Delta-to-cumulative conversion algorithm** (out-of-order and restart detection), source:
`#sums-detecting-alignment-issues`:

- "if the current point precedes the start time, then drop this point. Note: there are algorithms which
  can deal with late arriving points."
- "if the next point does NOT align with the expected next-time window, then reset the counter following
  the same steps performed as if the current point was the first point seen."
- Two triggers: (1) significant **overlap** with the previous interval: assume a single-writer
  violation and recommend dedup or resource differentiation; (2) significant **gap** from the last-seen
  time: assume a restart and reset the cumulative counter.
- Degenerate case: if data points carry no timestamps (possible when adapting non-OTel metric formats
  into OTLP), "the algorithm resets on every point."

---

## 4. Exponential histograms: mapping rules (working-level detail)

**Status: Stable** (data model fields). The mapping-function math below comes from the canonical spec
markdown (`specification/metrics/data-model.md`, ExponentialHistogram section).

- **Base formula**: `base = 2**(2**(-scale))`. At `scale = 0`, `base = 2`.
- **Bucket definition**: "bucket identified by `index`, a signed integer, represents values in the
  population that are greater than `base**index` and less than or equal to `base**(index+1)`."
- **Index constraint**: producers must ensure "the bucket index of any encoded bucket falls within the
  range of a signed 32-bit integer."
- **Scale = 0 mapping ("extract exponent")**: "the index of a value equals its normalized base-2
  exponent", derived from the IEEE-754 bit layout (no logarithm needed).
- **Scale ≤ 0 mapping ("extract and shift")**: equals the scale-0 mapping "shifted to the right by
  `-scale`".
- **General (any scale) mapping via logarithm**: `index == Ceiling(log(value)/log(base)) - 1`. In
  practice it is computed with a scaling factor `2**scale / log(2)` (e.g. `math.Ldexp(math.Log2E, scale)`
  in Go-style pseudocode) for numerical stability, instead of dividing by `log(base)` each time.
- **Negative values**: "mapped by their absolute value into the negative range using the same scale as
  the positive range". Positive and negative bucket sets share one `scale`.
- **Zero handling**: a dedicated `zero_count` bucket, with optional `zero_threshold`. "`zero_count`
  contains the count of values whose absolute value is less than or equal to `zero_threshold`." When
  `zero_threshold` is unset, the zero bucket also "stores values that cannot be expressed using the
  standard exponential formula as well as values that have been rounded to zero."
- **Downscaling (resolution reduction)**: "Buckets of an exponential Histogram with a given scale map
  exactly into buckets of exponential Histograms with lesser scales, which allows consumers to lower the
  resolution of a histogram (i.e., downscale) without introducing error". Merging is lossless when
  reducing scale. Implementations use this to fit `MaxSize` (default 160, see §2.2): they halve
  resolution until the active index range fits.

Source: https://opentelemetry.io/docs/specs/otel/metrics/data-model/#exponentialhistogram (rendered) and
`specification/metrics/data-model.md` (raw, for verbatim formula quotes).

---

## 5. Enumerated reference tables

### 5.1 Instrument → default aggregation → point kind produced

| Instrument                 | Sync/Async | Monotonic | Default aggregation       | Point kind on wire      |
| -------------------------- | ---------- | --------- | ------------------------- | ----------------------- |
| Counter                    | Sync       | Yes       | Sum                       | Sum (`monotonic=true`)  |
| UpDownCounter              | Sync       | No        | Sum                       | Sum (`monotonic=false`) |
| Histogram                  | Sync       | n/a       | Explicit Bucket Histogram | Histogram               |
| Gauge                      | Sync       | n/a       | Last Value                | Gauge                   |
| Asynchronous Counter       | Async      | Yes       | Sum                       | Sum (`monotonic=true`)  |
| Asynchronous UpDownCounter | Async      | No        | Sum                       | Sum (`monotonic=false`) |
| Asynchronous Gauge         | Async      | n/a       | Last Value                | Gauge                   |

### 5.2 Temporality preference matrix (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`)

**Status: Stable.** Default: `cumulative`.
Source: https://opentelemetry.io/docs/specs/otel/metrics/sdk_exporters/otlp/

| Preference value       | Counter (sync) | Async Counter | Histogram  | UpDownCounter (sync) | Async UpDownCounter |
| ---------------------- | -------------- | ------------- | ---------- | -------------------- | ------------------- |
| `cumulative` (default) | Cumulative     | Cumulative    | Cumulative | Cumulative           | Cumulative          |
| `delta`                | Delta          | Delta         | Delta      | Cumulative           | Cumulative          |
| `lowmemory`            | Delta          | Cumulative    | Delta      | Cumulative           | Cumulative          |

Notes verbatim:

- `delta`: "Choose Delta aggregation temporality for Counter, Asynchronous Counter and Histogram
  instrument kinds, choose Cumulative aggregation for UpDownCounter and Asynchronous UpDownCounter
  instrument kinds."
- `lowmemory`: "uses Delta aggregation temporality for Synchronous Counter and Histogram and uses
  Cumulative aggregation temporality for Synchronous UpDownCounter, Asynchronous Counter, and
  Asynchronous UpDownCounter instrument kinds". The difference from `delta` is that Asynchronous
  Counter stays Cumulative, so the SDK does not retain prior async-counter state to compute deltas.

### 5.3 Environment variables (Metrics)

| Variable                                                   | Default                     | Values                                                                               | Scope                           | Status                   |
| ---------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ | ------------------------------- | ------------------------ |
| `OTEL_METRICS_EXPORTER`                                    | `otlp`                      | `otlp`, `prometheus`, `console`, `logging` (deprecated), `none`, `otlp/stdout` (dev) | General SDK config              | Stable (mixed per value) |
| `OTEL_METRIC_EXPORT_INTERVAL`                              | `60000` (ms)                | duration                                                                             | Periodic Exporting MetricReader | Stable                   |
| `OTEL_METRIC_EXPORT_TIMEOUT`                               | `30000` (ms)                | duration                                                                             | Periodic Exporting MetricReader | Stable                   |
| `OTEL_METRICS_EXEMPLAR_FILTER`                             | `trace_based`               | `always_on`, `always_off`, `trace_based`                                             | Exemplar filter                 | Stable                   |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`        | `cumulative`                | `cumulative`, `delta`, `lowmemory` (case-insensitive)                                | OTLP metrics exporter           | Stable                   |
| `OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION` | `explicit_bucket_histogram` | `explicit_bucket_histogram`, `base2_exponential_bucket_histogram` (case-insensitive) | OTLP metrics exporter           | Stable                   |

The fetched general SDK env-vars page has no env var for the cardinality-limit default (2000). The
limit is a spec-defined constant applied through View/Reader precedence (§2.5). Treat this as
unverified absence, not confirmed non-existence: some language SDKs add their own env var.

Source: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/ ,
https://opentelemetry.io/docs/specs/otel/metrics/sdk_exporters/otlp/

### 5.4 Point kind × temporality applicability

| Point kind           | Delta valid? | Cumulative valid? | Notes                                                                                                                        |
| -------------------- | ------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Sum                  | Yes          | Yes               | `monotonic` flag independent of temporality                                                                                  |
| Gauge                | n/a          | n/a               | No aggregation temporality field; last-sample semantics only                                                                 |
| Histogram            | Yes          | Yes               | `min`/`max` "more useful for Delta temporality, since ... Cumulative min and max will stabilize as more events are recorded" |
| ExponentialHistogram | Yes          | Yes               | Same temporality semantics as Histogram                                                                                      |
| Summary (legacy)     | n/a          | n/a               | No temporality field; compatibility-only point kind                                                                          |

---

## Key references

- Metrics API: https://opentelemetry.io/docs/specs/otel/metrics/api/
- Metrics SDK: https://opentelemetry.io/docs/specs/otel/metrics/sdk/
- Metrics Data Model: https://opentelemetry.io/docs/specs/otel/metrics/data-model/
- Metrics overview: https://opentelemetry.io/docs/specs/otel/metrics/
- OTLP metrics exporter config: https://opentelemetry.io/docs/specs/otel/metrics/sdk_exporters/otlp/
- General SDK environment variables: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
- Canonical spec repo (source of truth for raw markdown): https://github.com/open-telemetry/opentelemetry-specification/tree/main/specification/metrics
    - `data-model.md` (point kinds, temporality, resets/gaps, exemplars, flags, single-writer, overlap)
    - `sdk.md` (Views, Aggregation, MetricReader, cardinality limits, exemplar filter/reservoir)
    - `api.md` (instrument definitions, naming rules)
- Prometheus staleness marker (referenced by the `NoRecordedValue` flag): https://prometheus.io/docs/prometheus/latest/querying/basics/#staleness
- OTEP 0113 (Exemplars design): https://github.com/open-telemetry/opentelemetry-specification/tree/main/oteps/metrics/0113-exemplars.md
- OTEP 0049 (Metric LabelSet): https://github.com/open-telemetry/opentelemetry-specification/tree/main/oteps/metrics/0049-metric-label-set.md
