# Ingest rules

Org admins can drop telemetry, parse log bodies into attributes, or redact values before Maple
stores or bills it. The ingest
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
   matches. Drop and redact conditions are evaluated against the record as received, before any
   rule changes it.
2. **Drop rules run first.** A record matching a drop rule is removed unless the rule keeps it by
   sampling. When several drop rules match, the record survives only if every one of them keeps it.
3. **Redact rules then run in `position` order** on the records that survived, each on the
   output of the previous one.
4. **Parse rules then run in `position` order** on the redacted logs (see "Parse rules"), so a
   parse step only ever reads redacted text. Each parse rule's conditions see the log as the
   earlier parse rules left it. The matched `attributes`- and `body`-scoped redact rules then run
   once more over the attributes parsing wrote, so key and detector rules reach them too.
5. A resource or scope left with no records is removed. A metric left with no data points is
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
`^maple_[a-z0-9_]+$` (`maple_org_id`, `maple_source_id`). Protection applies to top-level keys only;
the same names inside a kvlist value are customer data and are redacted like any other. Dotted Maple
keys such as `maple_ai.*` carry customer text and are redacted like any other.

- **`keys`** redact the whole value of a matching attribute.
    - A key pattern is a case-insensitive glob in which `*` matches any run of characters
      (`*password*`, `http.request.header.*`).
    - In a kvlist, a nested key is matched by its own name.
    - `body` has no key; key patterns never apply to it, except to keys inside a kvlist body.
- **`detectors`** and **`patterns`** replace only the matched text inside string values.
    - Values that are not strings are left alone.
    - At most the first 16 KiB of a value is scanned, counted in UTF-8 bytes and cut at the last
      whole character, and any longer remainder stays unscanned. The TS engine counts bytes too.
    - The 16 KiB cut happens once, before the first detector. Later detectors and patterns scan the
      rewritten head, whatever its length, and the unscanned tail is appended at the end.
    - Matches are leftmost-first and do not overlap. Empty matches are ignored, and the validator
      rejects a pattern that matches the empty string. Detectors run in the order listed, then
      patterns, each on the output of the previous one.
    - Under `mask` and `remove`, the detector list repeats until a pass replaces nothing: a mask is
      a new boundary, so `2001:db8::1:GB82WEST12345698765432` becomes
      `[REDACTED:ipv6][REDACTED:iban]` and a second application changes nothing. `hash` runs the
      list once, since a hash can itself match a detector.
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

**Profiles** (`ingest_rules::redact_profiles`) are not a rule signal. A profile carries the same
resource as the service's traces and logs, so every redact rule runs on it, whatever its signals,
and its conditions are ignored, since they describe spans, logs and metrics. A profile gets the
most redaction any rule asks for. `resource` covers each resource's attributes and `attributes`
the dictionary's attribute table (profile and sample attributes). Drop rules never apply to
profiles, and a profile's redactions are not counted in the rule stats.

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
- No repeated group that itself contains a repetition or an alternation (`(a+)+`, `(a|aa)+`).
- No two wide repetitions (unbounded, or more than 32 apart) that can match the same text without a
  required character between them that neither matches: `a*a*b`, `.*.*=` and `\w+\w+!` are
  refused, `[a-z]+@[a-z]+` and `\w+\s+\w+` are fine. Overlap is decided on a probe set of ASCII
  and representative Unicode characters.
- Inside `[...]`, no `\D`, `\W`, `\S`, `\b`, `\B` or nested `[`.
- No quantifier on `\b`, `\B`, `^` or `$`; JavaScriptCore (Bun, Safari) silently fails to match
  some of them on long text.
- Small enough for the gateway to compile under its 1 MiB limit. Unicode classes are large: `\w`
  and `\p{...}` fit about 20 copies, `\d` about 200, so `\w{32}` is refused and
  `[A-Za-z0-9_]{32}` is fine. Copies add up across the pattern and multiply through counted groups.
- Only a leading `(?i)` as an inline flag.

The Rust engine is linear-time, so a pattern cannot stall the gateway. The preview, MCP and local
mode run the JS engine, which backtracks; the repetition rules keep every accepted pattern within a
quadratic worst case over the 16 KiB window. Patterns mean what the gateway means: the TS engine
rewrites `\d`, `\w`, `\s`, `\b` (and their negations) to Rust's Unicode classes, and `.` to "any
character but `\n`", before compiling.

## Parse rules

A parse rule (`action._tag: "parse"`) applies to logs only (`signals` is exactly `["logs"]`). Its
conditions are the pipeline filter; its `steps` (1 to 10) run in order. The research and reasons
are in [log-parsing.md](log-parsing.md).

Every step reads one **source**: `source: "body"`, or `source: "attribute"` with `key`. A missing
source fails the step.

| Step        | Reads                                                       | Writes                                                                           |
| ----------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `json`      | text holding a JSON object, or a kvlist (a structured body) | one attribute per leaf, keys joined with `.` (`http.status`), each with `prefix` |
| `regex`     | text                                                        | one attribute per named group that took part in the match, `prefix` + group name |
| `grok`      | text                                                        | one attribute per `%{PATTERN:field}`, `prefix` + field                           |
| `severity`  | text or number                                              | `severity_number` and `severity_text`                                            |
| `timestamp` | text or number                                              | `time_unix_nano`                                                                 |

- **Output limit.** A `json`, `regex` or `grok` step writes at most 64 KiB, counting the UTF-8
  bytes of each key (prefix included) and string, byte arrays as they are, and 8 per number or
  bool; past it the step fails (`writes more than 64 KiB`) and writes nothing.
- **Writing attributes.** A written key replaces the first attribute with that key, or is
  appended. Protected keys (`service.name`, `org_id`, `maple_*` stamps) are never written.
- **JSON.** At most 64 KiB (UTF-8) of text, 16 levels of nesting (objects and arrays) and 128
  leaves; past any of these the step fails and writes nothing. Keys are visited in code point
  order, so when two paths flatten to one key (`{"a.b":1,"a":{"b":2}}`) the later one wins. An
  empty key below the top level is still a path component: `{"":{"x":1}}` writes `.x`. Arrays are kept whole as array values. `null` is skipped. A number that is a whole number
  within ±(2^53 - 1) becomes an int, any other a double.
- **Regex and grok** match unanchored within the first 16 KiB, like redaction. Both engines are
  linear-time (the `regex` crate here, RE2JS in the TS engine), so patterns may repeat freely.
  `\d`, `\w`, `\s` and `\b` (and negations) mean their ASCII forms. The validator accepts only
  syntax both engines share: no lookaround, backreferences, `\Q..\E`, `\C`, class set operations
  or inline flags other than a leading `(?i)`; regex group names are `[A-Za-z_][A-Za-z0-9_]*`.
- **Grok** expands `%{NAME}`, `%{NAME:field}` and `%{NAME:field:int|float}` from the curated
  library (`packages/domain/src/ingest-grok.ts`; the gateway carries the same table, both checked
  against `packages/ingest-rules/fixtures/grok-patterns.json`). It includes the usual building
  blocks (`INT`, `NUMBER`, `WORD`, `NOTSPACE`, `DATA`, `GREEDYDATA`, `QS`, `IP`, `HOSTNAME`,
  `URIPATHPARAM`, `TIMESTAMP_ISO8601`, `HTTPDATE`, `LOGLEVEL`, ...) and `COMMONAPACHELOG` /
  `COMBINEDAPACHELOG`, which write OTel semantic-convention keys (`client.address`,
  `http.request.method`, `http.response.status_code`, ...). Field names may use letters, digits,
  `_`, `.`, `@` and `-`. A `:int` or `:float` capture that does not convert stays text.
- **Severity.** A number 1 to 24 (or its text) is used as is. Otherwise the text is matched by
  ASCII-lowercase prefix: `trace` 1, `debug` 5, `info` 9, `notice` 10, `warn` 13, `err` 17,
  `fatal`, `crit`, `alert`, `emerg` 21. `severity_text` becomes the OTel short name of the number
  (`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`).
- **Timestamp** `format`: `rfc3339` (`2024-03-01T12:34:56.789+02:00`; `T`, `t` or a space; a
  fraction after `.` or `,`, read to 9 digits; `Z`, `+HH:MM`, `+HHMM` or no zone, meaning UTC),
  `unix_s`, `unix_ms`, `unix_us`, `unix_ns` (digits with an optional fraction), or `common_log`
  (`10/Oct/2000:13:55:36 -0700`). Numbers are read as their condition text. Invalid dates, times
  before 1970, `0` and values past `i64::MAX` nanoseconds (what the warehouse stores) fail.
- **Failures.** A failed step sets the log attribute `maple.parse.error` to
  `<step>: <reason>` (`regex: no match`, `json: not valid JSON`, `timestamp: out of range`, ...).
  Later steps still run and a rule keeps its first failure. The log is always kept. The marker
  counts as a parsed key, so an attribute redact rule can remove or mask it.
- **Conditions.** Drop and redact rules decide whether they apply on the log before parsing, so
  their conditions never see a value parsing produces: `not_exists(level)` still matches a log
  that parsing then gives a `level`, and a condition on a parsed attribute never matches; scope
  the redact rule instead. A parse rule's conditions see the attributes and body as redaction and
  earlier parse rules left them, and the resource as received (the gateway redacts a resource once
  all its records were evaluated).
- **Redaction.** Redaction runs before parsing, so a value a redact rule masks in the body or an
  attribute is masked in everything parsed from it, through any number of steps, and a
  contextual pattern (`password=[^ ]+`) masks the secret before a step could extract it. A parse
  step may therefore see `[REDACTED]` where it expects a value. Afterwards, the matched
  `attributes`- and `body`-scoped redact rules run on the keys parsing wrote; their counts add to
  the rule's `redacted_values`.
- **Metering.** Parsing never moves the bill: the net size change of parsing, including the
  redaction of the keys it wrote and overwrites that shorten a value, is taken back out, so a
  payload is metered on the size it was sent, less what drop rules removed. Measured per record
  with its length prefix; the prefixes of the enclosing scope and resource can still move by a
  byte or two each.
- **Budget.** In the gateway each parse rule may read 256 MiB and spend 250 ms per payload, and
  all parse rules together 1 GiB and 1 s; a rule's conditions and steps both count, and the
  clock is read before every rule and step. Past that, the rule stops parsing for the rest of that
  payload and each log it still matches gets `maple.parse.error: budget: ...` (a spent budget
  cannot run a regex condition, so a rule filtered by one stops matching). The payload is still
  stored: parse rules never spend the payload's redaction budget, and parse time does not count
  against its 2 second redaction deadline. The TS engine has no budget.
- **Stats.** A parse rule counts `matched` (logs it ran on) and `parse_failed` (logs where a step
  failed) in `org_ingest_rule_stats`.

## Gateway configuration

| Variable                      | Default | Meaning                                                                                                           |
| ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `INGEST_RULES_ENABLED`        | `true`  | Apply rules at all. Off never queries Postgres and costs nothing. A kill switch; the managed deploy leaves it on. |
| `INGEST_RULES_CACHE_TTL_SECS` | `30`    | How long an org's compiled rules are reused before a reload (min 1).                                              |

- Concurrent requests that miss the cache for one org share a single lookup.
- If a reload fails, the gateway keeps applying the last rules it loaded for that org (kept up to
  24 hours) and retries the lookup after 1 second. If it never loaded any, the request is refused
  with a retryable 503 (`Retry-After: 5`; gRPC `UNAVAILABLE`) rather than stored unredacted.
  Every failed lookup counts in `ingest_rules_fetch_failed_total`. A stored rule that does not
  parse or compile is skipped and counted in `ingest_rules_invalid_total`.
- Only the share of the payload the rules leave is metered, on every path (OTLP HTTP and gRPC,
  Cloudflare, GCP, AWS), and items are recounted after the rules. Dropped records are discounted
  by their encoded size; redaction is not, so it never bills more or less than was received.
  Bytes of dropped records count in `ingest_rules_dropped_bytes_total`.
- Per-rule counts (`matched`, `dropped`, `dropped_bytes`, `redacted_values`) are counted once the
  payload is written (or fully dropped), summed per org, rule, signal and UTC hour, and added into
  `org_ingest_rule_stats` every minute and on shutdown. A failed write keeps the counts for the
  next one; after 10 failures in a row they are dropped and counted in
  `ingest_rule_stats_dropped_total`.

## Limits

- 50 rules per org and 20 conditions per rule.
- 100 values per condition, each at most 1,024 characters.
- 32 keys and 10 patterns per rule, each pattern at most 512 characters.
- 10 steps per parse rule; a parse pattern at most 1,024 characters, a prefix at most 64.
- The gateway also caps a compiled regex at 1 MiB.
- All of an org's regexes together (conditions and patterns, enabled rules or not) are capped at
  an estimated 8 MiB compiled (`regexBudgetCost`); the API refuses a rule past it. The gateway
  measures the real size and refuses the org's payloads with a 503 past 16 MiB, rather than apply
  only some of its rules.
- One payload's rule pass may scan at most 1 GiB with conditions, detectors and patterns, summed
  over rules and passes, and may take at most 2 seconds. A payload that needs more is refused
  with a 413; smaller batches fit.

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
- `input.timeUnixNano` is a decimal string. `expected` lists `severityNumber`, `severityText` and
  `timeUnixNano` only when a parse rule changed them.
- **Value mapping.** A JSON string, bool or array maps to the same OTLP type. A JSON object maps to
  a kvlist. An integer maps to `int_value`, and a number with a fraction maps to `double_value`.
  `{ "$bytes": "<hex>" }` maps to bytes.
- **Expected values.** When `dropped` is true, the other `expected` fields are omitted. Otherwise
  `expected` gives the full `resource`, `attributes`, `body` (when the input has one) and `events`
  (when the input has them).

## Fuzzing

The fixtures pin chosen cases; three property suites cover the rest.

- `bun run --cwd packages/ingest-rules fuzz [--runs N] [--seed S]` generates rules and records,
  runs each through the TS engine and the gateway's (the `ingest_rules_oracle` example, built with
  `--features conformance`), and shrinks the first disagreement. It prints the differing path, the
  rules and a `--seed` to replay. CI runs 20,000 cases in the `ingest-rust` job.
- `packages/ingest-rules/src/invariants.test.ts`: protected keys never change, masked emails do not
  survive in scanned text, key and detector masking is idempotent, rules for other signals change
  nothing, and sampling keeps a trace whole.
- `packages/ingest-rules/src/regex-time.test.ts`: every pattern the validator accepts scans a
  16 KiB window of repetitive text within budget on the JS engine.
- `apps/ingest` (`ingest_rules::tests::properties`): compiling any rule never panics, and redacting
  arbitrarily nested values never touches a top-level protected key.

A disagreement the fuzzer finds becomes a fixture case once the engines agree again.
