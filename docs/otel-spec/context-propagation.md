# Context, Baggage & Propagation

This page covers the OpenTelemetry **Context** abstraction, the **Baggage** API and its W3C wire
format, and the **Propagators API** (W3C TraceContext primary; B3/Jaeger at reference level). It is
part of the internal OTel spec reference used for spec-compliance checks and the best-practices
skill. Every section links to its normative source. Verify against the source, not this summary,
before using anything here for a compliance decision.

> **Stability at a glance:**
>
> - Context API: Stable.
> - Propagators API: Stable (a few per-language details, e.g. `GetAll`, are pre-stable).
> - Baggage API: Stable.
> - W3C Trace Context: W3C Recommendation (normative, version `00`).
> - W3C Baggage: on the W3C Editor's Draft / Candidate Recommendation track, not yet a final REC
>   as of this writing. Treat it as stable in practice, but re-check its status.
> - OTel `tracestate` handling (the `ot=` vendor key, consistent probability sampling `th`/`rv`):
>   **Development** (not stable) at the OTel-spec level.

## Relevance to Maple

- Maple's Rust ingest gateway (`apps/ingest`) is an **OTLP receiver**, not an HTTP trace-context
  propagator. Incoming spans already carry `TraceId` / `SpanId` / `ParentSpanId` / `TraceState` as
  OTLP fields (populated upstream by the _sending_ SDK's propagator before OTLP export). These are
  inserted verbatim into ClickHouse/Tinybird (see `apps/ingest/src/clickhouse_insert_mappings.rs`,
  columns `TraceId`, `SpanId`, `ParentSpanId`, `TraceState`). Maple does not need to parse a
  `traceparent` HTTP header to ingest span data.
- W3C TraceContext propagation _does_ apply directly in two places. First, the ingest gateway's
  own **self-instrumentation** (`apps/ingest/src/otel.rs` exports its own OTLP traces). Second,
  outbound calls from Maple's Effect workers (api, ai, alerting) that should carry a live
  `Context`, such as `WarehouseQueryService` queries or Postgres calls over Hyperdrive. Those rely
  on the context
  propagation in `@maple-dev/effect-sdk` (`packages/effect-sdk`), which implements this spec.
  `service.name`, `deployment.environment.name`, etc. are Resource attributes, not part of Context
  propagation, though they ride the same SDK plumbing.
- Maple is a **backend for arbitrary customer OTLP**, so expect `TraceId`s from many upstream
  propagators: W3C, but also legacy B3/Jaeger bridged by some customer collectors. The ingest
  gateway should treat a **128-bit** `TraceId` and a **64-bit** `SpanId`/`ParentSpanId` as the
  canonical OTel shapes. A shorter ID (e.g. a 64-bit B3 trace ID zero-padded to 128 bits) is a
  valid _interop_ case, not a data error. See
  [B3/Jaeger interop notes](#b3-and-jaeger-reference-level) below.
- `Baggage` is orthogonal to span data: **baggage entries do not automatically become span
  attributes**. If Maple wants baggage values (e.g. a customer's `user.id` propagated via baggage)
  to show up as searchable span/log attributes, it needs an explicit "baggage → span attribute"
  bridge (a processor). This is useful when triaging "why isn't this baggage key showing up as a
  facet" questions.
- The W3C `tracestate` field is captured (`TraceState` column, `LinksTraceState` for span links).
  Maple reads one OTel `ot=` sub-key: the `traces.SampleRate` column default in
  `packages/domain/src/tinybird/datasources.ts` derives the sample rate from `th` when no
  `SampleRate` span attribute is set. `rv` is not used. The spec area is **Development**, so there
  is no compliance expectation beyond this. Revisit if OTel's consistent probability sampling
  stabilizes and Maple wants cross-service consistent sampling.

---

## Context

**Stability: Stable.**
Source: https://opentelemetry.io/docs/specs/otel/context/

`Context` is "a propagation mechanism which carries execution-scoped values across API
boundaries and between logically associated execution units." It underlies both distributed trace
propagation (via `SpanContext`) and Baggage propagation. It is general-purpose: any cross-cutting
concern can ride in `Context`.

### Immutability

> A `Context` **MUST** be immutable, and its write operations **MUST** result in the creation of a
> new `Context` containing the original values and the specified values updated.

A write (`SetValue`) never mutates the context you started with. It returns a new `Context`
layered on top of the old one. This is why context propagation composes safely across concurrent
call stacks: nobody can retroactively change a `Context` that another goroutine/task/fiber already
captured.

### Core operations

| Operation   | Signature (conceptual)             | Notes                                                                                                                                                                                                                  |
| ----------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateKey` | `(name: string) -> Key`            | `name` is for debugging only. "Multiple calls to `CreateKey` with the same name SHOULD NOT return the same value unless language constraints dictate otherwise." Keys are unforgeable/opaque, not string-keyed maps. |
| `GetValue`  | `(context, key) -> value`          | Read-only lookup against a given `Context`.                                                                                                                                                                            |
| `SetValue`  | `(context, key, value) -> Context` | Returns a **new** `Context`; does not mutate the input.                                                                                                                                                                |

### Implicit-context operations (languages with implicit/ambient context, e.g. via thread-locals or async-local storage)

| Operation             | Purpose                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Get Current Context` | Returns the `Context` associated with the current execution unit.                                                                                                                          |
| `Attach`              | Associates a given `Context` with the current execution unit; returns a **token** for later restoration.                                                                                   |
| `Detach`              | Resets the current context using the token returned by `Attach`. Implementations are expected to be able to signal incorrect call ordering (e.g. detaching out of order or detaching twice). |

Attach/detach is a stack-like discipline. Detach with the token from the matching attach; don't
just restore whatever was current a moment ago. Implementations may detect and signal misuse
(double detach, out-of-order detach), and are encouraged to.

---

## Propagators API

**Stability: Stable** (except where a language explicitly marks a piece, e.g. `GetAll`, as
pre-stable).
Source: https://opentelemetry.io/docs/specs/otel/context/api-propagators/

The Propagators API is how a `Context` (specifically, the active `SpanContext` and `Baggage`)
crosses a wire. It is format-agnostic. `TextMapPropagator` is the concrete shape used for
HTTP-style string-keyed carriers.

### `TextMapPropagator`

| Method                               | Contract                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Fields(carrier)`                    | Returns the propagation field/header names this propagator uses for a given carrier type. A caller can clear those fields before re-injecting into a reused carrier ("If your carrier is reused, you should delete the fields here before calling Inject").                                                                               |
| `Inject(context, carrier, setter?)`  | Writes values from `context` into `carrier` using `setter`.                                                                                                                                                                                                                                                                               |
| `Extract(context, carrier, getter?)` | Reads values from `carrier` and returns a **new** `Context` (per Context immutability) with the extracted values layered on top of the passed-in `context`. **On parse failure, the implementation MUST NOT throw and MUST NOT store a new value.** Extraction failures degrade to a no-op; they never crash the caller or poison the context. |

### `Setter` / `Getter` carrier interfaces

- **Setter.Set(carrier, key, value):** writes one field into the carrier. Implementations
  "SHOULD preserve casing" for case-insensitive protocols like HTTP headers (don't rewrite
  `Traceparent` to `traceparent` gratuitously).
- **Getter.Get(carrier, key):** returns the first value for `key`, or null/absent if not present.
  For HTTP-like carriers this "MUST be case insensitive."
- **Getter.Keys(carrier):** returns all keys in the carrier. This enables prefix/pattern-based
  extraction; the spec cites B3's `X-B3-*` family as the motivating example.
- **Getter.GetAll(carrier, key):** returns _all_ values for a repeated key, in original order
  (for headers that can legitimately repeat). Pre-stable in some language implementations.

Setter and Getter "MUST be stateless and allowed to be saved as constants." They carry no
per-call state, so one shared instance is safe to reuse across concurrent injects/extracts.

### Composite Propagator

Multiple `TextMapPropagator`s can be combined into one composite propagator. The composite runs
its constituent propagators **in the order they were specified**, for both `Inject` and `Extract`.
Order matters only if propagators touch the same carrier keys; `tracecontext` and `baggage`
normally touch disjoint headers.

### Global propagator registration

The API defines a way to get and set a process-wide default propagator. Per spec, implementations
"MUST use no-op propagators unless explicitly configured otherwise." Propagation is opt-in at the
raw-API level; SDKs, not the bare API, typically wire up defaults. Guidance for pre-configured
platforms (e.g. ASP.NET) is to default to a composite of W3C TraceContext + W3C Baggage.

### `OTEL_PROPAGATORS` environment variable

Source: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/

| Env var            | Description                                                          | Default                |
| ------------------ | -------------------------------------------------------------------- | ---------------------- |
| `OTEL_PROPAGATORS` | Comma-separated list of propagators to register, composited together | `tracecontext,baggage` |

| Value          | Propagator                             | Status         |
| -------------- | -------------------------------------- | -------------- |
| `tracecontext` | W3C Trace Context                      | Stable         |
| `baggage`      | W3C Baggage                            | Stable         |
| `b3`           | B3 Single header                       | (none listed)  |
| `b3multi`      | B3 Multi header                        | (none listed)  |
| `jaeger`       | Jaeger `uber-trace-id`                 | **Deprecated** |
| `xray`         | AWS X-Ray (third-party format)         | (none listed)  |
| `ottrace`      | OT Trace                               | **Deprecated** |
| `none`         | No automatically configured propagator | (none listed)  |

Values **MUST be deduplicated**, so a propagator is registered only once even if named twice (or
implied twice by other config).

### Propagators distribution

Source: https://opentelemetry.io/docs/specs/otel/context/api-propagators/#propagators-distribution

- **OTel-maintained packages:** W3C TraceContext, W3C Baggage, B3.
- **Additional/optional packages:** Jaeger (Deprecated), OT Trace (Deprecated), OpenCensus
  BinaryFormat.
- Vendor-specific propagator formats "MUST NOT be maintained or distributed as part of the
  OpenTelemetry Core packages." They live in contrib/vendor repos.

---

## W3C Trace Context: `traceparent`

**Status: W3C Recommendation** (normative wire format). This section assumes version `00`.
Source: https://www.w3.org/TR/trace-context/#traceparent-header

### Grammar (§3.2, ABNF)

```
HEXDIGLC      = DIGIT / "a" / "b" / "c" / "d" / "e" / "f"
value         = version "-" version-format
version       = 2HEXDIGLC
version-format = trace-id "-" parent-id "-" trace-flags
trace-id      = 32HEXDIGLC   ; 16 bytes
parent-id     = 16HEXDIGLC   ; 8 bytes
trace-flags   = 2HEXDIGLC    ; 1 byte
```

Example: `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`

### Field-by-field

| Field                        | Size     | Encoding               | Invalid value                                 | On invalid, receiver behavior                                                                                                                  |
| ---------------------------- | -------- | ---------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                    | 1 byte   | 2 lowercase hex digits | `ff` is explicitly forbidden                  | Reject/ignore the header                                                                                                                       |
| `trace-id`                   | 16 bytes | 32 lowercase hex chars | All-zero (`00000000000000000000000000000000`) | Invalid. Vendors **must ignore** a `traceparent` with an invalid trace-id (treat it as if no `traceparent` was received; start a new trace)    |
| `parent-id` (a.k.a. span-id) | 8 bytes  | 16 lowercase hex chars | All-zero (`0000000000000000`)                 | Invalid. Same treatment: ignore the header                                                                                                     |
| `trace-flags`                | 1 byte   | 2 lowercase hex digits | None (all 256 bit patterns are structurally valid) | Level 1 defines only the least-significant bit (`sampled`). Level 2 (CR) also defines bit 1 (`random`)                                   |

### Sampled flag (trace-flags LSB)

> When set, the least significant bit (right-most), denotes that the caller may have recorded
> trace data.

This is **not** a command to sample. It communicates the upstream's own recording decision so
downstream participants can make consistent decisions; each vendor's sampler still owns its own
decision. Other trace-flags bits are reserved. A producer MUST set bits it doesn't understand to
`0` (don't invent bit meanings).

### Version handling (§3.2.4 "Versioning of traceparent")

- `version = ff` is invalid outright.
- If a receiver sees a **higher** version than it knows, it MUST still try to parse the fields it
  understands from a version-`00`-shaped payload: `trace-id` as the 32 hex chars after the first
  dash, `parent-id` as the next 16 hex chars, and the sampled bit from the `trace-flags` byte that
  follows. It then ignores any trailing fields the newer version appends.
    - If the header is shorter than 55 characters (the version-00 length), the receiver should not
      parse it and should restart the trace (treat it as absent) rather than guess.
- When forwarding an unknown-version header, reset unknown flag bits to zero on the outgoing
  request. Don't forward bits you don't understand as if you understood them.

### Practical MUSTs for an ingest gateway

- Reject (treat as absent, start fresh) a `traceparent` whose `trace-id` or `parent-id` is
  all-zero. These are the two explicitly normative "invalid value" cases.
- Never throw on a malformed `traceparent`. Per the Propagators API contract, extraction failure
  degrades to "no context extracted", not an exception.
- Reset `trace-flags` bits you don't understand to `0` when re-emitting. Don't round-trip unknown
  bits.

---

## W3C Trace Context: `tracestate`

**Status: W3C Recommendation.**
Source: https://www.w3.org/TR/trace-context/#tracestate-header

### Grammar (§3.3, ABNF)

```
list         = list-member 0*31( OWS "," OWS list-member )
list-member  = (key "=" value) / OWS ; allows empty list-members
key          = simple-key / multi-tenant-key
simple-key   = lcalpha 0*255( lcalpha / DIGIT / "_" / "-"/ "*" / "/" )
multi-tenant-key = tenant-id "@" system-id
tenant-id    = ( lcalpha / DIGIT ) 0*240( lcalpha / DIGIT / "_" / "-"/ "*" / "/" )
system-id    = lcalpha 0*13( lcalpha / DIGIT / "_" / "-"/ "*" / "/" )
lcalpha      = %x61-7A ; a-z
value        = 0*255(chr) nblk-chr
nblk-chr     = %x21-2B / %x2D-3C / %x3E-7E
chr          = %x20 / nblk-chr
```

### Key rules

| Key form         | Format                                     | Purpose                                                                                                          |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Simple key       | lowercase alphanum + `_ - * /`, ≤256 chars | Single-tenant vendor identifier, e.g. `congo`                                                                    |
| Multi-tenant key | `tenant-id@system-id`                      | Lets a multi-tenant vendor (`system-id`) namespace by `tenant-id`, so lookups can jump straight to `@system-id` |

### Value rules

Opaque, printable ASCII (`0x20`-`0x7E`), **excluding** comma and `=`. Max **256 characters**.

### Limits

| Limit                                                      | Value                                                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Max list-members                                           | 32                                                                                                                                     |
| Max total header size a vendor should be able to propagate | 512 characters                                                                                                                         |
| Truncation strategy when trimming to fit                   | Drop entries over 128 characters first, then drop from the end of the list. Only whole list-members may be dropped, never partial ones |

### Mutation rules (§3.5 "Mutating the tracestate Field")

- A participant adding a new entry inserts it **at the front (left)** of the list.
- A participant updating its own existing entry **moves it to the front** (as if delete +
  re-add).
- Only one entry per key is allowed. It represents that vendor's _last_ position in the trace; a
  vendor re-entering the trace overwrites its previous entry rather than appending a duplicate.
  All other, unmodified list-members must keep their order.
- Deleting keys: a vendor should not delete keys it did not generate. Removing another vendor's
  entry breaks that vendor's correlation, so participants should be conservative about deleting
  others' state.

### OTel's own `tracestate` usage: the `ot=` vendor key

**Status: Development (not stable).**
Source: https://opentelemetry.io/docs/specs/otel/trace/tracestate-handling/ ,
https://opentelemetry.io/docs/specs/otel/trace/tracestate-probability-sampling/

OpenTelemetry SDKs consolidate all OTel-internal `tracestate` data into a **single** list-member
under the key `ot`. Its value is an internal `;`-separated set of sub-keys (e.g.
`ot=th:c8;rv:1a2b3c...`), capped at 256 characters for that entry. Individual instrumentation
libraries get their own list-member keys rather than writing into the shared `ot` entry.

| Sub-key | Meaning                                                                                                                                                                         | Format                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `th`    | Sampling **threshold** (rejection threshold `T`); conveys effective sampling probability. `0` = 100% sampling. Probability = `(2^56 - Threshold) / 2^56`.                       | 1-14 lowercase hex digits (conceptually right-padded to 56 bits)  |
| `rv`    | Explicit **randomness value**: an alternative source of the common random value `R` used for consistent sampling decisions, instead of the trailing bits of the `trace-id` | Exactly 14 lowercase hex digits                                   |
| `p`     | Legacy probability encoding that predates `th`/`rv`                                                                                                                            | (not specified here)                                              |

This mechanism underpins **OTel consistent probability sampling**. Every participant compares the
shared randomness `R` (from `rv`, or else the low 7 bytes of the `trace-id`) against its own
rejection threshold `T` (`th`). Independently configured samplers along a trace then make
_consistent_ keep/drop decisions without agreeing out of band. The whole area is **Development**
in the OTel spec. Do not treat it as a compliance requirement, but recognize `ot=th:...;rv:...` in
customer `tracestate` values.

---

## Baggage

### API

**Stability: Stable.**
Source: https://opentelemetry.io/docs/specs/otel/baggage/api/

| Operation        | Signature                                      | Notes                                                                                                                                                                 |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Get Value`      | `(baggage, name) -> value \| absent`           | Simple lookup.                                                                                                                                                        |
| `Get All Values` | `(baggage) -> [(name, value, metadata)]`       | Order is **not significant**; may be exposed as an iterator or immutable collection.                                                                                  |
| `Set Value`      | `(baggage, name, value, metadata?) -> Baggage` | Returns a new `Baggage`. `metadata` is "an opaque wrapper for a string with no semantic meaning" to the API itself (vendor-defined use, e.g. W3C's `property` syntax). |
| `Remove Value`   | `(baggage, name) -> Baggage`                   | Returns a new `Baggage` without that entry.                                                                                                                           |

Entry shape: **key** is any non-empty valid UTF-8 string, case-sensitive; **value** is any valid
UTF-8 string, case-sensitive; **metadata** is an optional opaque string. A name has exactly one
value at a time (setting again replaces it).

**Security requirement:** "To avoid sending any name/value pairs to an untrusted process, the
Baggage API MUST provide a way to remove all baggage entries from a context." A
`ClearBaggage`-equivalent full wipe is mandatory, framed as a trust-boundary safeguard.

**Baggage and span attributes are separate concerns.** The Baggage API spec only defines the
`Baggage` value type and its context-scoped CRUD. It says nothing about copying baggage into span
attributes. Across OTel, **baggage entries do NOT automatically become span attributes** (or
log/metric attributes). That correlation needs an explicit bridge/processor that reads `Baggage`
from `Context` and calls `SetAttribute` on the current span. Treat "baggage shows up as a span
attribute" as something that must be deliberately wired.

### W3C Baggage header: wire format

**Status:** W3C Editor's Draft. Baggage has moved through the W3C process more slowly than Trace
Context; re-verify its current status before citing it as a final Recommendation.
Source: https://www.w3.org/TR/baggage/

#### Grammar

```
baggage-string  = list-member 0*179( OWS "," OWS list-member )
list-member     = key OWS "=" OWS value *( OWS ";" OWS property )
key             = token                     ; RFC 7230 token, ASCII only
value           = *baggage-octet            ; percent-encode anything outside this set
property        = key OWS "=" OWS value / key OWS
```

`baggage-octet` excludes control characters, whitespace, `"`, `,`, `;`, and `\`. Any character
outside the allowed set must be percent-encoded per RFC 3986.

#### Limits

| Limit             | Requirement                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Max list-members  | Implementations **must** propagate all list-members when the total is **64 or fewer**                                                                 |
| Max header size   | Implementations **must** propagate the full baggage-string when it is **8192 bytes or fewer**                                                         |
| Over either limit | Implementations **may** drop list-members to come back into compliance (no normative drop order is mandated, unlike `tracestate`)                      |

No minimum-length constraint is specified for individual keys/values.

#### Security considerations

> Application owners should either ensure that no proprietary or confidential information is
> stored in baggage, or they should ensure that baggage isn't present in requests that cross
> trust-boundaries.

The spec also expects implementations to defend against malicious or oversized baggage strings
(length validation, careful parsing) to avoid buffer-overflow/injection-style failures on receipt.
This applies to Maple's ingest gateway if it ever parses inbound `baggage` headers rather than
only OTLP payloads.

---

## B3 and Jaeger (reference level)

Neither is part of OTel's default propagator set (`tracecontext,baggage`). B3 is an OTel-maintained
extension package; Jaeger propagation is **Deprecated** in OTel. They are documented here because
Maple, as an ingest backend, may see traffic from collectors/proxies that still emit them.

Source (B3): https://github.com/openzipkin/b3-propagation
Source (Jaeger, reference): https://www.jaegertracing.io/docs/1.6/client-libraries/#tracespan-identity ,
deprecation noted at https://opentelemetry.io/docs/specs/otel/context/api-propagators/#propagators-distribution

### B3 multi-header format

| Header              | Format                                                                           |
| ------------------- | -------------------------------------------------------------------------------- |
| `X-B3-TraceId`      | 16 (64-bit) or 32 (128-bit) lowercase hex chars                                  |
| `X-B3-SpanId`       | 16 lowercase hex chars (64-bit)                                                  |
| `X-B3-ParentSpanId` | 16 lowercase hex chars; optional, absent on root spans                           |
| `X-B3-Sampled`      | `1` = accept/sampled, `0` = deny/not-sampled; absent = defer decision downstream |
| `X-B3-Flags`        | Debug flag; `1` implies an accept/sampled decision, overriding `X-B3-Sampled`    |

### B3 single-header format

Header name: `b3`. Format: `b3: {TraceId}-{SpanId}-{SamplingState}-{ParentSpanId}`; the last two
fields are optional. `SamplingState`: `1` = accept, `0` = deny, `d` = debug, absent = defer.

Examples: `b3: 80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-1-05e3ac9a4f6e3b90`,
`b3: 0` (deny only), `b3: 80f198ee56343ba864fe8b2a57d3eff7-e457b5a2e4d86bd1-d` (debug).

When both single- and multi-header forms are present, the single-header (`b3`) form takes
precedence.

### Jaeger `uber-trace-id`

Header: `uber-trace-id: {trace-id}:{span-id}:{parent-span-id}:{flags}`.

- `trace-id`: 16 or 32 hex chars (64-bit or 128-bit). Shorter values are zero-padded on the left
  when converting to/from OTel's fixed 128-bit `TraceId`.
- `span-id`: 16 hex chars.
- `parent-span-id`: historically present but deprecated/unused; conventionally `0`.
- `flags`: one byte as two hex digits (bit 0 = sampled, like W3C's trace-flags LSB).

OTel's docs mark the Jaeger propagator/format as **Deprecated** in favor of W3C Trace Context.
New integrations should not add Jaeger propagation; consume it only for legacy interop.

### 64-bit vs 128-bit trace-id interop note

OTel's canonical `TraceId` is always 128-bit (32 hex chars) internally. B3 and Jaeger both allow
legacy 64-bit trace IDs. The standard interop rule (as implemented by OTel's B3/Jaeger
propagators): a 64-bit incoming trace-id is **zero-extended on the left** to fill the 128-bit
`TraceId`. On the way back out to a 64-bit-only system, the low 64 bits are used. So Maple ingest
should not treat a `TraceId` with a long run of leading zero bytes as anomalous; it is a legitimate
signature of a bridged 64-bit trace ID. The all-zero rejection rule applies to **W3C `traceparent`
parsing specifically**. It is not a generic rule for OTLP payloads that already carry a `TraceId`
field.

---

## Key references

- OTel Context spec: https://opentelemetry.io/docs/specs/otel/context/
- OTel Propagators API spec: https://opentelemetry.io/docs/specs/otel/context/api-propagators/
- OTel Propagators distribution: https://opentelemetry.io/docs/specs/otel/context/api-propagators/#propagators-distribution
- OTel Baggage API spec: https://opentelemetry.io/docs/specs/otel/baggage/api/
- OTel SDK environment variables (`OTEL_PROPAGATORS`): https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
- OTel TraceState handling (`ot=` vendor key): https://opentelemetry.io/docs/specs/otel/trace/tracestate-handling/
- OTel TraceState probability sampling (`th`/`rv`): https://opentelemetry.io/docs/specs/otel/trace/tracestate-probability-sampling/
- W3C Trace Context (Recommendation): https://www.w3.org/TR/trace-context/
- W3C Baggage (Editor's Draft/CR): https://www.w3.org/TR/baggage/
- B3 propagation (OpenZipkin): https://github.com/openzipkin/b3-propagation
- Jaeger client trace/span identity (`uber-trace-id`): https://www.jaegertracing.io/docs/1.6/client-libraries/#tracespan-identity
- Canonical spec repo: https://github.com/open-telemetry/opentelemetry-specification
