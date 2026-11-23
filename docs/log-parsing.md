# Log parsing at ingest: design decision

Most teams send messy text logs. Maple parses them at ingest as a third kind of ingest rule,
`parse`, next to `drop` and `redact`. The contract is the "Parse rules" section of
[ingest-rules.md](ingest-rules.md); this page records why it looks the way it does.

## What others do

| Product        | Unit                                             | Filter                       | Processors                                                                                                                                          | Order and failures                                                                     | Preview                                                |
| -------------- | ------------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| SigNoz         | Pipeline (filter + ordered processors)           | Query-builder expression     | Regex (RE2), grok, JSON, trace, timestamp, severity parsers; add, remove, move, copy                                                                | Pipelines in list order; compiled to OTel Collector operators shipped over OpAMP       | "Simulate processing" on sample logs from the database |
| Datadog        | Pipeline (filter + processors), can nest         | Log search query             | Grok (several rules, helper rules), date, status, service, message and attribute remappers, URL and UA parsers, arithmetic, string builder, lookups | Every matching pipeline runs in order; a grok that matches nothing just leaves the log | Grok parser tests against sample lines                 |
| Grafana Alloy  | `loki.process` stages                            | `stage.match` selector       | `stage.json`, `stage.regex`, `stage.logfmt`, `stage.timestamp`, `stage.labels`, `stage.drop`                                                        | Stages in order; extracted values are scratch until promoted                           | None built in                                          |
| OTel Collector | `transform` processor (OTTL) or stanza operators | OTTL `where` / operator `if` | `ParseJSON`, `ExtractPatterns`, `ExtractGrokPatterns`, `merge_maps`; `json_parser`, `regex_parser` with severity and timestamp sub-parsers          | `on_error: send` keeps the log by default                                              | None                                                   |
| Better Stack   | VRL transformations and SQL expressions          | In the expression            | Anything VRL can do; SQL expressions also turn logs into metrics at ingest                                                                          | Script order                                                                           | Live tail                                              |
| Dash0          | Automatic Log AI                                 | None (unstructured logs)     | Infers patterns, `dash0.log.attribute.*` values and severity                                                                                        | Flags what it inferred with `dash0.log.ai.*_inferred`                                  | Shown in the UI                                        |

## Decision

1. **A parse rule is an ingest rule.** `signals` + `conditions` are the pipeline filter, the
   action holds ordered `steps`, `position` orders pipelines. This is SigNoz's and Datadog's model
   and reuses everything rules already have: storage, the v2 API, the MCP tools, local mode, the
   per-rule stats sink, the settings page and its preview over recent real logs.
2. **Steps:** `json` (flatten an object or structured body into dotted attributes), `regex`
   (named groups), `grok` (a curated library, `%{PATTERN:field:int}`), `severity` and
   `timestamp`. Add/move/remove attribute already exist as attribute mappings; a message remapper
   and logfmt are follow-ups.
3. **Order: drop, redact, parse, then redact what parsing wrote.** Drops see the log as received,
   so a dropped log is never parsed and parsing's added bytes are never billed. Parsing reads only
   redacted text, so no field can carry what a redact rule masked, however many steps derive it
   and whatever context the redact pattern needed. Attribute and body redact rules then run again
   on the parsed keys, so key rules like `*password*` reach them. (A first version tracked which
   attributes came from the body instead; review showed chained steps and contextual patterns
   escape that.)
4. **Linear-time regexes in both engines.** The gateway uses the `regex` crate; the preview, MCP
   and local mode use RE2JS (RE2 syntax, like SigNoz). Neither backtracks, so parse patterns need
   none of the repetition limits redact patterns have, and `%{DATA} %{GREEDYDATA}` grok is fine.
   `\d`, `\w`, `\s` and `\b` mean their ASCII (RE2) forms in both.
5. **Failures are kept and recorded, never dropped.** A failed step sets `maple.parse.error`
   (`regex: no match`), later steps still run, and the rule's `parse_failed` count goes up. This is
   the Collector's `on_error: send`, made visible.
6. **Bounded cost.** Each parse rule may read 256 MiB and spend 250 ms per payload, all parse rules
   together 1 GiB and 1 s; past that the rule stops parsing the rest of that payload and records
   a `budget:` failure instead of refusing it. JSON is capped at 64 KiB, 16 levels and 128 fields
   per value; regex and grok read the first 16 KiB, like redaction.
7. **Two engines, one contract.** As with drop and redact, `packages/ingest-rules/fixtures/parse.json`
   runs in `cargo test` and vitest, and both grok tables are checked against one JSON file.

Not chosen: an expression language (VRL, OTTL) is more powerful but needs a second interpreter
in TS for the preview and is far harder to bound; AI parsing is a later layer that could suggest
grok patterns for the same rule type.
