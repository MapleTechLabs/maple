# Ingest rules

Org admins can drop telemetry or redact values in it before Maple stores or bills it. The ingest
gateway (`apps/ingest/src/ingest_rules.rs`) applies the rules to the decoded OTLP payload after
enrichment and before the WAL append, the S3 segment shipping and the collector forward. Bytes a
rule drops are never metered. The TS engine (`packages/ingest-rules`) runs the same rules for the
settings preview, the `preview_ingest_rule` MCP tool and local mode. The shared fixtures in
`packages/ingest-rules/fixtures/` run in both `cargo test` and vitest, so the two cannot drift.

The schema and the validator are `packages/domain/src/ingest-rules.ts`. v1 covers OTLP traces,
logs and metrics, including the Cloudflare, GCP and AWS connectors. Session events, product events
and replays are not covered.

## Records

A rule looks at one **record** at a time:

| Signal  | Record       | `name`      | `attribute`           | Also                                |
| ------- | ------------ | ----------- | --------------------- | ----------------------------------- |
| traces  | a span       | span name   | span attributes       | span kind, status, events, trace id |
| logs    | a log record | (none)      | log attributes        | body, severity, trace id            |
| metrics | a data point | metric name | data point attributes | exemplars (redaction only)          |

`service_name` and `resource_attribute` read the record's resource.

## Evaluation

1. A rule applies to a record when the record's signal is in `signals` and **every** condition
   matches. Conditions are evaluated against the record as received, before any rule changes it.
2. **Drop rules run first.** A record matching a drop rule is removed unless the rule keeps it by
   sampling. When several drop rules match, the record survives only if every one of them keeps it.
3. **Redact rules then run in `position` order** on the records that survived, each on the output
   of the previous one.
4. A resource or scope left with no records is removed. A metric left with no data points is
   removed.

### Conditions

Values are compared as strings. An attribute value becomes a string as follows:

- A string stays as it is.
- An int is written in decimal.
- A bool is `true` or `false`.
- A double is written the way Rust's `{}` prints it: shortest round-trip digits, never exponent form
  (`1.5`, `2`, `1000000000000000000000`, `0.0000001`, `-0`).
- Bytes, arrays and kvlists never match a value comparison, including `neq` and `not_in`. They
  only satisfy `exists`.

| op                      | Meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `eq` / `neq`            | equal / not equal to `value`                                            |
| `in` / `not_in`         | equal to one of / none of `values`                                      |
| `prefix` / `contains`   | starts with / contains `value`                                          |
| `regex`                 | `value` matches anywhere in the first 16 KiB of the string (unanchored) |
| `exists` / `not_exists` | the attribute is / is not present                                       |
| `lt` / `gte`            | severity below / at or above the named level                            |

- **Missing attributes.** A missing attribute fails every op except `neq`, `not_in` and
  `not_exists`, which pass.
- **Missing service name.** A missing `service.name` compares as the empty string.
- **Severity.** Severity is `severity_number`. When that is 0, the gateway derives it from
  `severity_text`, case-insensitively, by prefix: `trace` 1, `debug` 5, `info` 9, `warn` 13,
  `err` 17, `fatal`/`crit`/`emerg` 21. A record whose severity is still unknown matches no
  severity condition.
- **Span kind and status.** `span_kind` is one of `unspecified`, `internal`, `server`, `client`,
  `producer`, `consumer`. `span_status` is one of `unset`, `ok`, `error`.

### Sampling (`keepPercent`)

- `keepPercent` 0 drops every match and 100 keeps every match.
- In between, a record with a trace id is kept when `u64_be(sha256(lowercase hex trace id)[0..8])
  % 100 < keepPercent`. Every span and log of a trace therefore gets the same answer.
- A record without a trace id is kept at random. The fixtures do not exercise that case.
- Metric drops are always 0.

### Redaction

`scopes` says where to look:

- `attributes`: the record's attributes. For metrics this also covers the `filtered_attributes` of
  the data point's exemplars, which can carry the same values.
- `resource`: resource attributes.
- `events`: span event attributes, where `exception.message` lives.
- `body`: the log body.

Arrays and kvlists are searched recursively. The `attributes` scope also covers the span status
message (detectors and patterns only; it has no key). Keys that route, attribute or bill data are
**protected** and never changed: `service.name`, `org_id`, and the gateway's own stamps, which match
`^maple_[a-z0-9_]+$` (`maple_org_id`, `maple_source_id`). Dotted Maple keys such as `maple_ai.*`
carry customer text and are redacted like any other.

- **`keys`** redact the whole value of a matching attribute.
    - A key pattern is a case-insensitive glob in which `*` matches any run of characters
      (`*password*`, `http.request.header.*`).
    - In a kvlist, a nested key is matched by its own name.
    - `body` has no key; key patterns never apply to it, except to keys inside a kvlist body.
- **`detectors`** and **`patterns`** replace only the matched text inside string values.
    - Values that are not strings are left alone.
    - At most the first 16 KiB of a value is scanned (bytes in the gateway, UTF-16 code units in TS,
      the same for ASCII), and any longer remainder stays unscanned.
    - The 16 KiB cut happens once, before the first detector. Later detectors and patterns scan the
      rewritten head, whatever its length, and the unscanned tail is appended at the end.
    - Matches are leftmost-first and do not overlap. Empty matches are ignored, and the validator
      rejects a pattern that matches the empty string. Detectors run in the order listed, then
      patterns, each on the output of the previous one.
- **Methods**:

| Method   | Key match                                             | Detector or pattern match                            |
| -------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `mask`   | value becomes `[REDACTED]`                            | text becomes `[REDACTED:<detector>]` or `[REDACTED]` |
| `hash`   | string value becomes `hash:<hex16>`; other types mask | text becomes `hash:<hex16>`                          |
| `remove` | the attribute is removed                              | same as `mask`                                       |

`hex16` is the first 16 lower-case hex characters of `HMAC-SHA256(key = org hash salt, message =
the UTF-8 text)`. The salt is per org. Hashing is pseudonymization: anyone with the salt can test
guesses for low-entropy values such as phone numbers.

Within one rule, a value replaced by a key match is final: that rule's detectors and patterns do
not scan it. Later rules see the replacement like any other value. A later detector
can still match text inside a replacement, so never write a detector that matches `[REDACTED`.

### Detectors

Each detector is a regex built from ASCII classes and bounded quantifiers only, so the Rust and JS
engines agree and neither can backtrack badly. Some
add a check on the match. "Bounded" means the characters immediately before and after the match
must not be ASCII letters or digits.

| Detector      | Regex                                                                                                       | Extra check                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`       | `[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}`                    | none                                                                                                                                               |
| `credit_card` | `[0-9](?:[ -]?[0-9]){12,18}`                                                                                | bounded; 13 to 19 digits after removing spaces and dashes; Luhn                                                                                    |
| `jwt`         | `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*`                                                      | none                                                                                                                                               |
| `api_token`   | see `API_TOKEN` below                                                                                       | bounded                                                                                                                                            |
| `ipv4`        | `(?:(?:25[0-5]\|2[0-4][0-9]\|1[0-9]{2}\|[1-9]?[0-9])\.){3}(?:25[0-5]\|2[0-4][0-9]\|1[0-9]{2}\|[1-9]?[0-9])` | bounded; the preceding character is not `.`; the following character is not `.` followed by a digit                                                |
| `ipv6`        | `[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}`                                                                | bounded (also not `:` around the match); contains `::` exactly once with at most 7 colons, or exactly 7 colons and no `::`; at least one hex digit |
| `phone`       | `\+[0-9][0-9 ().-]{6,18}[0-9]\|\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}`                                    | bounded; 10 to 15 digits                                                                                                                           |
| `iban`        | `[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?`                                                | bounded; mod-97 check on the value with spaces removed                                                                                             |

`API_TOKEN` is one alternation:

```
(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|[Bb]earer [A-Za-z0-9._~+/=-]{8,}
```

**A candidate that fails its check is skipped, and the scan resumes one character after the start
of that candidate.**

### Custom regexes

The validator accepts only the subset of syntax that both the Rust `regex` crate and JS `RegExp`
with the `u` flag accept:

- No lookaround, backreferences, atomic groups or possessive quantifiers.
- No class set operations (`&&`, `~~`, `--` inside `[...]`), `[^]`, `\c` or `\0`.
- Counted repetitions up to 999.
- No repeated group that itself contains a repetition or an alternation (`(a+)+`, `(a|aa)+`): the
  preview and local mode run the JS engine, which backtracks on them.
- Only a leading `(?i)` as an inline flag.

The Rust engine is linear-time, so a pattern cannot stall the gateway. Shorthand classes (`\d`,
`\w`, `\s`, `\b`) are Unicode-aware in Rust and ASCII-only in JS. Prefer explicit ASCII classes;
the two engines agree on ASCII input either way.

## Gateway configuration

| Variable                      | Default | Meaning                                                              |
| ----------------------------- | ------- | -------------------------------------------------------------------- |
| `INGEST_RULES_ENABLED`        | `false` | Apply rules at all. Off never queries Postgres and costs nothing.    |
| `INGEST_RULES_CACHE_TTL_SECS` | `30`    | How long an org's compiled rules are reused before a reload.         |

- If a reload fails, the gateway keeps applying the last rules it loaded for that org (no rules if
  it never loaded any) and counts `ingest_rules_fetch_failed_total`. A stored rule that does not
  parse or compile is skipped and counted in `ingest_rules_invalid_total`.
- Only the share of the payload the rules leave is metered, on every path (OTLP HTTP and gRPC,
  Cloudflare, GCP, AWS). Redaction that makes a payload larger never bills more than was received.
  Bytes of dropped records count in `ingest_rules_dropped_bytes_total`.
- Per-rule counts (`matched`, `dropped`, `dropped_bytes`, `redacted_values`) are summed per org,
  rule, signal and UTC hour, and added into `org_ingest_rule_stats` every minute and on shutdown.
  A failed write keeps the counts for the next one; after 10 failures in a row they are dropped
  and counted in `ingest_rule_stats_dropped_total`.

## Limits

- 50 rules per org and 20 conditions per rule.
- 100 values per condition, each at most 1,024 characters.
- 32 keys and 10 patterns per rule, each pattern at most 512 characters.
- The gateway also caps a compiled regex at 1 MiB.

## Fixture format

Each `packages/ingest-rules/fixtures/*.json` is an array of cases:

```json
{
	"name": "masks emails in log attributes",
	"salt": "fixture-salt",
	"rules": [{ "signals": ["logs"], "conditions": [], "action": { "_tag": "redact", "...": "..." } }],
	"input": {
		"signal": "logs",
		"resource": { "service.name": "api" },
		"attributes": { "user.email": "a@b.co" },
		"body": "login from a@b.co",
		"severityNumber": 9,
		"severityText": "INFO",
		"traceId": "0af7651916cd43dd8448eb211c80319c",
		"name": "GET /users",
		"spanKind": "server",
		"spanStatus": "ok",
		"events": [{ "name": "exception", "attributes": { "exception.message": "..." } }]
	},
	"expected": { "dropped": false, "resource": {}, "attributes": {}, "body": "...", "events": [] }
}
```

- Rules are applied in array order, which stands in for `position`.
- **Value mapping.** A JSON string, bool or array maps to the same OTLP type. A JSON object maps to
  a kvlist. An integer maps to `int_value`, and a number with a fraction maps to `double_value`.
  `{ "$bytes": "<hex>" }` maps to bytes.
- **Expected values.** When `dropped` is true, the other `expected` fields are omitted. Otherwise
  `expected` gives the full `resource`, `attributes`, `body` (when the input has one) and `events`
  (when the input has them).
