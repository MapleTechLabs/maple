//! Parse rules: JSON, regex, grok, severity and timestamp steps that turn a log's body or an
//! attribute into attributes. The TS twin is `packages/ingest-rules/src/parse.ts`; the parse
//! fixtures hold both to `docs/ingest-rules.md` ("Parse rules").

use std::time::Duration;

use opentelemetry_proto::tonic::common::v1::{
    any_value, AnyValue, ArrayValue, KeyValue, KeyValueList,
};
use opentelemetry_proto::tonic::logs::v1::LogRecord;
use regex_automata::meta::{self, Regex};
use regex_automata::util::syntax;
use regex_automata::{Input, MatchKind};
use serde::Deserialize;
use serde_json::Value;

use super::{
    floor_char_boundary, format_double, is_protected_key, ScanBudget, REGEX_SIZE_LIMIT, SCAN_BYTES,
};

/// Log attribute a failed step sets, e.g. `regex: no match`. A rule keeps its first failure.
pub const PARSE_ERROR_KEY: &str = "maple.parse.error";
/// Bytes one parse rule may read in one payload, and for how long, before it stops parsing.
pub(super) const RULE_SCAN_BYTES: u64 = 256 << 20;
pub(super) const RULE_SCAN_TIME: Duration = Duration::from_millis(250);
/// What all of a payload's parse rules may spend together.
pub(super) const PAYLOAD_SCAN_BYTES: u64 = 1 << 30;
pub(super) const PAYLOAD_SCAN_TIME: Duration = Duration::from_secs(1);
const JSON_BYTES: usize = 64 * 1024;
const JSON_DEPTH: usize = 16;
const JSON_FIELDS: usize = 128;
/// Keys and values one step may write; more fails and writes none.
const OUTPUT_BYTES: usize = 64 * 1024;
const OUTPUT_FAILURE: &str = "writes more than 64 KiB";
/// Whole numbers within this become ints, as in the TS engine (`Number.isSafeInteger`).
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;
const GROK_MAX_DEPTH: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseSource {
    Body,
    Attribute,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimestampFormat {
    Rfc3339,
    UnixS,
    UnixMs,
    UnixUs,
    UnixNs,
    CommonLog,
}

impl TimestampFormat {
    fn name(self) -> &'static str {
        match self {
            Self::Rfc3339 => "rfc3339",
            Self::UnixS => "unix_s",
            Self::UnixMs => "unix_ms",
            Self::UnixUs => "unix_us",
            Self::UnixNs => "unix_ns",
            Self::CommonLog => "common_log",
        }
    }
}

/// One step as `packages/domain/src/ingest-rules.ts` encodes it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "_tag", rename_all = "snake_case")]
pub enum ParseStepSpec {
    Json {
        source: ParseSource,
        #[serde(default)]
        key: Option<String>,
        #[serde(default)]
        prefix: Option<String>,
    },
    Regex {
        source: ParseSource,
        #[serde(default)]
        key: Option<String>,
        pattern: String,
        #[serde(default)]
        prefix: Option<String>,
    },
    Grok {
        source: ParseSource,
        #[serde(default)]
        key: Option<String>,
        pattern: String,
        #[serde(default)]
        prefix: Option<String>,
    },
    Severity {
        source: ParseSource,
        #[serde(default)]
        key: Option<String>,
    },
    Timestamp {
        source: ParseSource,
        #[serde(default)]
        key: Option<String>,
        format: TimestampFormat,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldType {
    Text,
    Int,
    Float,
}

#[derive(Debug)]
struct Field {
    group: String,
    name: String,
    kind: FieldType,
}

#[derive(Debug)]
enum StepKind {
    Json {
        prefix: String,
    },
    Pattern {
        label: &'static str,
        prefix: String,
        regex: Regex,
        fields: Vec<Field>,
    },
    Severity,
    Timestamp(TimestampFormat),
}

#[derive(Debug)]
pub(super) struct CompiledStep {
    source: ParseSource,
    key: String,
    kind: StepKind,
}

impl CompiledStep {
    fn label(&self) -> &'static str {
        match &self.kind {
            StepKind::Json { .. } => "json",
            StepKind::Pattern { label, .. } => label,
            StepKind::Severity => "severity",
            StepKind::Timestamp(_) => "timestamp",
        }
    }

    pub(super) fn regex_bytes(&self) -> usize {
        match &self.kind {
            StepKind::Pattern { regex, .. } => regex.memory_usage(),
            _ => 0,
        }
    }
}

/// The curated grok library; `packages/domain/src/ingest-grok.ts` holds the same table and the
/// tests check both against `packages/ingest-rules/fixtures/grok-patterns.json`.
const GROK_PATTERNS: &[(&str, &str)] = &[
    ("USERNAME", r"[a-zA-Z0-9._-]+"),
    ("USER", r"%{USERNAME}"),
    ("INT", r"[+-]?[0-9]+"),
    ("BASE10NUM", r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)"),
    ("NUMBER", r"%{BASE10NUM}"),
    ("BASE16NUM", r"[+-]?(?:0x)?[0-9A-Fa-f]+"),
    ("POSINT", r"[1-9][0-9]*"),
    ("NONNEGINT", r"[0-9]+"),
    ("WORD", r"[A-Za-z0-9_]+"),
    ("NOTSPACE", r"[^ \t\r\n]+"),
    ("SPACE", r"[ \t\r\n]*"),
    ("DATA", r".*?"),
    ("GREEDYDATA", r".*"),
    ("QUOTEDSTRING", r#""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#),
    ("QS", r"%{QUOTEDSTRING}"),
    (
        "UUID",
        r"[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}",
    ),
    ("MAC", r"(?:[A-Fa-f0-9]{2}[:-]){5}[A-Fa-f0-9]{2}"),
    (
        "IPV4",
        r"(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])",
    ),
    ("IPV6", r"(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4}"),
    ("IP", r"%{IPV6}|%{IPV4}"),
    (
        "HOSTNAME",
        r"[A-Za-z0-9][A-Za-z0-9-]{0,62}(?:\.[A-Za-z0-9][A-Za-z0-9-]{0,62})*\.?",
    ),
    ("IPORHOST", r"%{IP}|%{HOSTNAME}"),
    ("HOSTPORT", r"%{IPORHOST}:%{POSINT}"),
    ("EMAILADDRESS", r"[a-zA-Z0-9._%+-]+@%{HOSTNAME}"),
    ("URIPROTO", r"[A-Za-z][A-Za-z0-9+.-]*"),
    ("URIHOST", r"%{IPORHOST}(?::%{POSINT})?"),
    ("URIPATH", r"(?:/[A-Za-z0-9$.+!*'(){},~:;=@#%&_-]*)+"),
    ("URIPARAM", r"\?[A-Za-z0-9$.+!*'|(){},~@#%&/=:;_?<>-]*"),
    ("URIPATHPARAM", r"%{URIPATH}(?:%{URIPARAM})?"),
    (
        "URI",
        r"%{URIPROTO}://(?:%{USER}(?::[^@]*)?@)?(?:%{URIHOST})?(?:%{URIPATHPARAM})?",
    ),
    ("PATH", r"(?:/[^ \t\r\n/]*)+"),
    (
        "MONTH",
        r"Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?",
    ),
    ("MONTHNUM", r"0?[1-9]|1[0-2]"),
    ("MONTHDAY", r"0[1-9]|[12][0-9]|3[01]|[1-9]"),
    (
        "DAY",
        r"Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?",
    ),
    ("YEAR", r"[0-9]{4}"),
    ("HOUR", r"2[0-3]|[01]?[0-9]"),
    ("MINUTE", r"[0-5][0-9]"),
    ("SECOND", r"(?:[0-5]?[0-9]|60)(?:[.,][0-9]+)?"),
    ("TIME", r"%{HOUR}:%{MINUTE}(?::%{SECOND})?"),
    ("ISO8601_TIMEZONE", r"Z|[+-]%{HOUR}(?::?%{MINUTE})?"),
    (
        "TIMESTAMP_ISO8601",
        r"%{YEAR}-%{MONTHNUM}-%{MONTHDAY}[T ]%{HOUR}:?%{MINUTE}(?::?%{SECOND})?(?:%{ISO8601_TIMEZONE})?",
    ),
    ("HTTPDATE", r"%{MONTHDAY}/%{MONTH}/%{YEAR}:%{TIME} %{INT}"),
    ("SYSLOGTIMESTAMP", r"%{MONTH} +%{MONTHDAY} %{TIME}"),
    (
        "LOGLEVEL",
        r"[Tt]race|TRACE|[Dd]ebug|DEBUG|[Ii]nfo|INFO|[Nn]otice|NOTICE|[Ww]arn(?:ing)?|WARN(?:ING)?|[Ee]rr(?:or)?|ERR(?:OR)?|[Cc]rit(?:ical)?|CRIT(?:ICAL)?|[Ff]atal|FATAL|[Ss]evere|SEVERE|[Ee]merg(?:ency)?|EMERG(?:ENCY)?|[Aa]lert|ALERT",
    ),
    (
        "COMMONAPACHELOG",
        r#"%{IPORHOST:client.address} %{USER:ident} %{USER:auth} \[%{HTTPDATE:timestamp}\] "(?:%{WORD:http.request.method} %{NOTSPACE:url.original}(?: HTTP/%{NUMBER:network.protocol.version})?|%{DATA:raw_request})" %{INT:http.response.status_code:int} (?:%{INT:http.response.body.size:int}|-)"#,
    ),
    (
        "COMBINEDAPACHELOG",
        r"%{COMMONAPACHELOG} %{QS:http.request.referrer} %{QS:user_agent.original}",
    ),
];

fn grok_definition(name: &str) -> Option<&'static str> {
    GROK_PATTERNS
        .iter()
        .find(|(candidate, _)| *candidate == name)
        .map(|(_, definition)| *definition)
}

fn valid_field_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '@')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | '-'))
}

/// Expands `%{NAME[:field[:int|float]]}` the way `expandGrok` in the TS engine does, so group
/// `g<i>` fills `fields[i]`.
fn expand_grok(
    text: &str,
    depth: usize,
    out: &mut String,
    fields: &mut Vec<Field>,
) -> Result<(), String> {
    let mut rest = text;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("%{") {
            let end = after.find('}').ok_or("a %{ is not closed")?;
            let inner = &after[..end];
            let mut parts = inner.split(':');
            let name = parts.next().unwrap_or_default();
            let field = parts.next();
            let kind = parts.next();
            if parts.next().is_some() {
                return Err(format!("%{{{inner}}} has too many parts"));
            }
            let definition =
                grok_definition(name).ok_or_else(|| format!("unknown grok pattern {name}"))?;
            if depth >= GROK_MAX_DEPTH {
                return Err("grok patterns nest too deeply".to_owned());
            }
            let kind = match kind {
                None => FieldType::Text,
                Some("int") => FieldType::Int,
                Some("float") => FieldType::Float,
                Some(other) => return Err(format!("field type {other} must be int or float")),
            };
            match field {
                Some(field) if !valid_field_name(field) => {
                    return Err(format!("invalid field name {field}"));
                }
                Some(field) => {
                    let group = format!("g{}", fields.len());
                    out.push_str("(?<");
                    out.push_str(&group);
                    out.push('>');
                    fields.push(Field {
                        group,
                        name: field.to_owned(),
                        kind,
                    });
                }
                None => out.push_str("(?:"),
            }
            expand_grok(definition, depth + 1, out, fields)?;
            out.push(')');
            rest = &after[end + 1..];
        } else if let Some(after) = rest.strip_prefix('\\') {
            out.push('\\');
            let Some(next) = after.chars().next() else {
                break;
            };
            out.push(next);
            rest = &after[next.len_utf8()..];
        } else {
            let Some(next) = rest.chars().next() else {
                break;
            };
            out.push(next);
            rest = &rest[next.len_utf8()..];
        }
    }
    Ok(())
}

/// Rewrites `\d`, `\w`, `\s` and `\b` (and their negations) to their ASCII forms, which is what
/// they mean in RE2, the engine the preview runs. The validator refuses negated shorthands
/// inside a class.
fn ascii_shorthands(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 16);
    let mut in_class = false;
    // Just after `[` or `[^`, where `]` is a literal.
    let mut class_start = false;
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let Some(next) = chars.next() else {
                out.push('\\');
                break;
            };
            let replacement = match (in_class, next) {
                (false, 'd') => Some("[0-9]"),
                (false, 'D') => Some("[^0-9]"),
                (false, 'w') => Some("[0-9A-Za-z_]"),
                (false, 'W') => Some("[^0-9A-Za-z_]"),
                (false, 's') => Some(r"[\t\n\x0C\r ]"),
                (false, 'S') => Some(r"[^\t\n\x0C\r ]"),
                (false, 'b') => Some(r"(?-u:\b)"),
                (false, 'B') => Some(r"(?-u:\B)"),
                (true, 'd') => Some("0-9"),
                (true, 'w') => Some("0-9A-Za-z_"),
                (true, 's') => Some(r"\t\n\x0C\r "),
                _ => None,
            };
            if let Some(replacement) = replacement {
                out.push_str(replacement);
            } else {
                out.push('\\');
                out.push(next);
            }
            class_start = false;
            continue;
        }
        if in_class {
            if c == ']' && !class_start {
                in_class = false;
            }
            class_start = false;
        } else if c == '[' {
            in_class = true;
            class_start = true;
            out.push(c);
            if chars.peek() == Some(&'^') {
                out.push('^');
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Like the redact regexes, but captures are read, so the one-pass engine stays on.
fn build_capture_regex(pattern: &str) -> Result<Regex, String> {
    meta::Builder::new()
        .configure(
            meta::Config::new()
                .match_kind(MatchKind::LeftmostFirst)
                .utf8_empty(true)
                .nfa_size_limit(Some(REGEX_SIZE_LIMIT))
                .onepass_size_limit(Some(REGEX_SIZE_LIMIT))
                .hybrid_cache_capacity(REGEX_SIZE_LIMIT),
        )
        .syntax(syntax::Config::new().utf8(true))
        .build(&ascii_shorthands(pattern))
        .map_err(|error| format!("invalid parse regex {pattern:?}: {error}"))
}

fn compile_pattern(label: &'static str, pattern: &str) -> Result<(Regex, Vec<Field>), String> {
    if label == "grok" {
        let mut regex = String::with_capacity(pattern.len() * 2);
        let mut fields = Vec::new();
        expand_grok(pattern, 0, &mut regex, &mut fields)?;
        if fields.is_empty() {
            return Err("a grok pattern needs a field".to_owned());
        }
        return Ok((build_capture_regex(&regex)?, fields));
    }
    let regex = build_capture_regex(pattern)?;
    let fields: Vec<Field> = regex
        .group_info()
        .pattern_names(regex_automata::PatternID::ZERO)
        .flatten()
        .map(|name| Field {
            group: name.to_owned(),
            name: name.to_owned(),
            kind: FieldType::Text,
        })
        .collect();
    if fields.is_empty() {
        return Err("a parse regex needs a named group".to_owned());
    }
    Ok((regex, fields))
}

pub(super) fn compile_steps(steps: Vec<ParseStepSpec>) -> Result<Vec<CompiledStep>, String> {
    if steps.is_empty() {
        return Err("a parse rule needs a step".to_owned());
    }
    steps
        .into_iter()
        .map(|step| {
            let (source, key, kind) = match step {
                ParseStepSpec::Json {
                    source,
                    key,
                    prefix,
                } => (
                    source,
                    key,
                    StepKind::Json {
                        prefix: prefix.unwrap_or_default(),
                    },
                ),
                ParseStepSpec::Regex {
                    source,
                    key,
                    pattern,
                    prefix,
                } => {
                    let (regex, fields) = compile_pattern("regex", &pattern)?;
                    (
                        source,
                        key,
                        StepKind::Pattern {
                            label: "regex",
                            prefix: prefix.unwrap_or_default(),
                            regex,
                            fields,
                        },
                    )
                }
                ParseStepSpec::Grok {
                    source,
                    key,
                    pattern,
                    prefix,
                } => {
                    let (regex, fields) = compile_pattern("grok", &pattern)?;
                    (
                        source,
                        key,
                        StepKind::Pattern {
                            label: "grok",
                            prefix: prefix.unwrap_or_default(),
                            regex,
                            fields,
                        },
                    )
                }
                ParseStepSpec::Severity { source, key } => (source, key, StepKind::Severity),
                ParseStepSpec::Timestamp {
                    source,
                    key,
                    format,
                } => (source, key, StepKind::Timestamp(format)),
            };
            let key = match (source, key) {
                (ParseSource::Attribute, Some(key)) if !key.is_empty() => key,
                (ParseSource::Attribute, _) => {
                    return Err("an attribute source needs a key".to_owned())
                }
                (ParseSource::Body, _) => String::new(),
            };
            Ok(CompiledStep { source, key, kind })
        })
        .collect()
}

/// What a step produced.
enum Outcome {
    Fields(Vec<(String, AnyValue)>),
    Severity(i32),
    Time(u64),
    Failed(&'static str),
    FailedOwned(String),
}

fn any(value: any_value::Value) -> AnyValue {
    AnyValue { value: Some(value) }
}

/// The value as a string, as conditions compare it; `None` for bytes, arrays and kvlists.
fn text_of(value: &AnyValue) -> Option<std::borrow::Cow<'_, str>> {
    use std::borrow::Cow;
    match value.value.as_ref()? {
        any_value::Value::StringValue(text) => Some(Cow::Borrowed(text)),
        any_value::Value::IntValue(int) => Some(Cow::Owned(int.to_string())),
        any_value::Value::BoolValue(flag) => {
            Some(Cow::Borrowed(if *flag { "true" } else { "false" }))
        }
        any_value::Value::DoubleValue(double) => Some(Cow::Owned(format_double(*double))),
        _ => None,
    }
}

/// Deepest nesting of `{` and `[` outside strings.
fn json_depth(text: &str) -> usize {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for byte in text.bytes() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
        } else {
            match byte {
                b'"' => in_string = true,
                b'{' | b'[' => {
                    depth += 1;
                    deepest = deepest.max(depth);
                }
                b'}' | b']' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    deepest
}

fn value_depth(value: &AnyValue) -> usize {
    match value.value.as_ref() {
        Some(any_value::Value::ArrayValue(array)) => {
            1 + array.values.iter().map(value_depth).max().unwrap_or(0)
        }
        Some(any_value::Value::KvlistValue(list)) => {
            1 + list
                .values
                .iter()
                .filter_map(|kv| kv.value.as_ref())
                .map(value_depth)
                .max()
                .unwrap_or(0)
        }
        _ => 0,
    }
}

fn json_number(number: &serde_json::Number) -> any_value::Value {
    if let Some(int) = number.as_i64() {
        if int.unsigned_abs() <= MAX_SAFE_INTEGER.unsigned_abs() {
            return any_value::Value::IntValue(int);
        }
    }
    let double = number.as_f64().unwrap_or(f64::NAN);
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a whole number within 2^53 is exact"
    )]
    #[expect(clippy::cast_precision_loss, reason = "2^53 - 1 is exact in f64")]
    if double.fract() == 0.0 && double.abs() <= MAX_SAFE_INTEGER as f64 {
        return any_value::Value::IntValue(double as i64);
    }
    any_value::Value::DoubleValue(double)
}

/// A JSON value as an attribute value; `None` for null. Object keys go in code point order.
fn from_json(value: &Value) -> Option<AnyValue> {
    let inner = match value {
        Value::Null => return None,
        Value::Bool(flag) => any_value::Value::BoolValue(*flag),
        Value::Number(number) => json_number(number),
        Value::String(text) => any_value::Value::StringValue(text.clone()),
        Value::Array(items) => any_value::Value::ArrayValue(ArrayValue {
            values: items.iter().filter_map(from_json).collect(),
        }),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            any_value::Value::KvlistValue(KeyValueList {
                values: keys
                    .into_iter()
                    .filter_map(|key| {
                        from_json(&map[key]).map(|value| KeyValue {
                            key: key.clone(),
                            value: Some(value),
                            ..Default::default()
                        })
                    })
                    .collect(),
            })
        }
    };
    Some(any(inner))
}

/// Flattens kvlist entries into dotted keys, visiting keys in code point order; arrays stay whole.
fn flatten<'a>(entries: &'a [KeyValue], path: &str, out: &mut Vec<(String, &'a AnyValue)>) {
    let mut sorted: Vec<&KeyValue> = entries.iter().collect();
    sorted.sort_by(|left, right| left.key.cmp(&right.key));
    for kv in sorted {
        let Some(value) = kv.value.as_ref().filter(|value| value.value.is_some()) else {
            continue;
        };
        let full = if path.is_empty() {
            kv.key.clone()
        } else {
            format!("{path}.{}", kv.key)
        };
        match value.value.as_ref() {
            Some(any_value::Value::KvlistValue(list)) => flatten(&list.values, &full, out),
            _ => out.push((full, value)),
        }
    }
}

/// Bytes a written value counts, as `parseOutputSize` in the TS engine: UTF-8 text and keys,
/// byte arrays as is, 8 per number or bool.
fn value_size(value: &AnyValue) -> usize {
    match value.value.as_ref() {
        None => 0,
        Some(any_value::Value::StringValue(text)) => text.len(),
        Some(any_value::Value::BytesValue(bytes)) => bytes.len(),
        Some(any_value::Value::ArrayValue(array)) => array
            .values
            .iter()
            .map(value_size)
            .fold(0, usize::saturating_add),
        Some(any_value::Value::KvlistValue(list)) => list
            .values
            .iter()
            .map(|kv| {
                kv.key
                    .len()
                    .saturating_add(kv.value.as_ref().map_or(0, value_size))
            })
            .fold(0, usize::saturating_add),
        Some(_) => 8,
    }
}

/// What a step's fields add up to, keys with their prefix included.
fn output_size<'a>(prefix: &str, fields: impl Iterator<Item = (&'a str, &'a AnyValue)>) -> usize {
    fields
        .map(|(key, value)| {
            prefix
                .len()
                .saturating_add(key.len())
                .saturating_add(value_size(value))
        })
        .fold(0, usize::saturating_add)
}

/// Charges what would be written and refuses it past `OUTPUT_BYTES`, before anything is copied.
fn checked_output(
    prefix: &str,
    fields: &[(String, &AnyValue)],
    budget: &mut ScanBudget,
) -> Option<&'static str> {
    if fields.len() > JSON_FIELDS {
        return Some("more than 128 fields");
    }
    let size = output_size(
        prefix,
        fields.iter().map(|(key, value)| (key.as_str(), *value)),
    );
    budget.charge(size);
    (size > OUTPUT_BYTES).then_some(OUTPUT_FAILURE)
}

fn run_json(value: &AnyValue, prefix: &str, budget: &mut ScanBudget) -> Outcome {
    let mut fields = Vec::new();
    match value.value.as_ref() {
        Some(any_value::Value::StringValue(text)) => {
            budget.charge(text.len());
            if text.len() > JSON_BYTES {
                return Outcome::Failed("larger than 64 KiB");
            }
            if json_depth(text) > JSON_DEPTH {
                return Outcome::Failed("nested deeper than 16 levels");
            }
            let Ok(parsed) = serde_json::from_str::<Value>(text) else {
                return Outcome::Failed("not valid JSON");
            };
            if !parsed.is_object() {
                return Outcome::Failed("not an object");
            }
            let Some(AnyValue {
                value: Some(any_value::Value::KvlistValue(list)),
            }) = from_json(&parsed)
            else {
                return Outcome::Failed("not an object");
            };
            flatten(&list.values, "", &mut fields);
            if let Some(reason) = checked_output(prefix, &fields, budget) {
                return Outcome::Failed(reason);
            }
            Outcome::Fields(owned(fields))
        }
        Some(any_value::Value::KvlistValue(list)) => {
            if value_depth(value) > JSON_DEPTH {
                return Outcome::Failed("nested deeper than 16 levels");
            }
            flatten(&list.values, "", &mut fields);
            if let Some(reason) = checked_output(prefix, &fields, budget) {
                return Outcome::Failed(reason);
            }
            Outcome::Fields(owned(fields))
        }
        _ => Outcome::Failed("source is not text or a map"),
    }
}

fn owned(fields: Vec<(String, &AnyValue)>) -> Vec<(String, AnyValue)> {
    fields
        .into_iter()
        .map(|(key, value)| (key, value.clone()))
        .collect()
}

fn is_int_text(text: &str) -> bool {
    let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn is_float_text(text: &str) -> bool {
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(at) => (&body[..at], Some(&body[at + 1..])),
        None => (body, None),
    };
    let (whole, fraction) = match mantissa.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (mantissa, None),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = match fraction {
        None => !whole.is_empty() && digits(whole),
        Some(fraction) => {
            digits(whole) && digits(fraction) && !(whole.is_empty() && fraction.is_empty())
        }
    };
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    mantissa_ok && exponent_ok
}

/// A grok `:int` or `:float` capture; text that does not convert stays text.
fn typed(text: &str, kind: FieldType) -> AnyValue {
    match kind {
        FieldType::Int if is_int_text(text) => match text.parse::<i64>() {
            Ok(int) => any(any_value::Value::IntValue(int)),
            Err(_) => any(any_value::Value::StringValue(text.to_owned())),
        },
        FieldType::Float if is_float_text(text) => match text.parse::<f64>() {
            Ok(double) if double.is_finite() => any(any_value::Value::DoubleValue(double)),
            _ => any(any_value::Value::StringValue(text.to_owned())),
        },
        _ => any(any_value::Value::StringValue(text.to_owned())),
    }
}

fn run_pattern(
    regex: &Regex,
    fields: &[Field],
    value: &AnyValue,
    budget: &mut ScanBudget,
) -> Outcome {
    let Some(any_value::Value::StringValue(text)) = value.value.as_ref() else {
        return Outcome::Failed("source is not text");
    };
    let window = &text[..floor_char_boundary(text, SCAN_BYTES)];
    budget.charge(window.len());
    let mut captures = regex.create_captures();
    regex.search_captures(&Input::new(window), &mut captures);
    if !captures.is_match() {
        return Outcome::Failed("no match");
    }
    Outcome::Fields(
        fields
            .iter()
            .filter_map(|field| {
                let span = captures.get_group_by_name(&field.group)?;
                Some((field.name.clone(), typed(&window[span.range()], field.kind)))
            })
            .collect(),
    )
}

const SEVERITY_PREFIXES: [(&str, i32); 10] = [
    ("trace", 1),
    ("debug", 5),
    ("info", 9),
    ("notice", 10),
    ("warn", 13),
    ("err", 17),
    ("fatal", 21),
    ("crit", 21),
    ("alert", 21),
    ("emerg", 21),
];

/// The OTel short name for a severity number.
fn severity_name(number: i32) -> &'static str {
    match number {
        ..=4 => "TRACE",
        5..=8 => "DEBUG",
        9..=12 => "INFO",
        13..=16 => "WARN",
        17..=20 => "ERROR",
        _ => "FATAL",
    }
}

fn run_severity(value: &AnyValue) -> Outcome {
    let Some(text) = text_of(value) else {
        return Outcome::Failed("source is not text");
    };
    let numeric = if (1..=2).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit()) {
        text.parse::<i32>().unwrap_or(0)
    } else {
        0
    };
    let number = if (1..=24).contains(&numeric) {
        numeric
    } else {
        let lower = text.to_ascii_lowercase();
        SEVERITY_PREFIXES
            .iter()
            .find(|(prefix, _)| lower.starts_with(prefix))
            .map_or(0, |(_, level)| *level)
    };
    if number == 0 {
        Outcome::Failed("unknown level")
    } else {
        Outcome::Severity(number)
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn digits_at(text: &[u8], at: usize, width: usize) -> Option<i64> {
    let slice = text.get(at..at + width)?;
    if !slice.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(
        slice
            .iter()
            .fold(0, |acc, b| acc * 10 + i64::from(b - b'0')),
    )
}

struct Civil {
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    nanos: u64,
    offset_minutes: i64,
}

enum TimeError {
    Format,
    Range,
}

fn civil_nanos(civil: &Civil) -> Result<u64, TimeError> {
    let valid = (1..=12).contains(&civil.month)
        && civil.day >= 1
        && civil.day <= days_in_month(civil.year, civil.month)
        && civil.hour <= 23
        && civil.minute <= 59
        && civil.second <= 59;
    if !valid {
        return Err(TimeError::Range);
    }
    let seconds = days_from_civil(civil.year, civil.month, civil.day) * 86_400
        + civil.hour * 3600
        + civil.minute * 60
        + civil.second
        - civil.offset_minutes * 60;
    let seconds = u64::try_from(seconds).map_err(|_| TimeError::Range)?;
    seconds
        .checked_mul(1_000_000_000)
        .and_then(|nanos| nanos.checked_add(civil.nanos))
        .ok_or(TimeError::Range)
}

/// `Z`, `+HH:MM`, `+HHMM` or nothing (`colon_ok`), or exactly `+HHMM` otherwise.
fn zone_at(text: &[u8], at: usize, colon_ok: bool) -> Option<i64> {
    let rest = text.get(at..)?;
    if rest.is_empty() {
        return colon_ok.then_some(0);
    }
    if colon_ok && (rest == b"Z" || rest == b"z") {
        return Some(0);
    }
    let sign = match rest[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let hours = digits_at(rest, 1, 2)?;
    let with_colon = colon_ok && rest.get(3) == Some(&b':');
    let minutes = digits_at(rest, if with_colon { 4 } else { 3 }, 2)?;
    let length = if with_colon { 6 } else { 5 };
    if rest.len() != length || hours > 23 || minutes > 59 {
        return None;
    }
    Some(sign * (hours * 60 + minutes))
}

fn parse_rfc3339(text: &[u8]) -> Option<Civil> {
    let separators = text.get(4) == Some(&b'-')
        && text.get(7) == Some(&b'-')
        && matches!(text.get(10), Some(b'T' | b't' | b' '))
        && text.get(13) == Some(&b':')
        && text.get(16) == Some(&b':');
    if !separators {
        return None;
    }
    let (year, month, day) = (
        digits_at(text, 0, 4)?,
        digits_at(text, 5, 2)?,
        digits_at(text, 8, 2)?,
    );
    let (hour, minute, second) = (
        digits_at(text, 11, 2)?,
        digits_at(text, 14, 2)?,
        digits_at(text, 17, 2)?,
    );
    let mut at = 19;
    let mut nanos = 0u64;
    if matches!(text.get(at), Some(b'.' | b',')) {
        let digits = text[at + 1..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if digits == 0 {
            return None;
        }
        for index in 0..9 {
            let digit = if index < digits {
                u64::from(text[at + 1 + index] - b'0')
            } else {
                0
            };
            nanos = nanos * 10 + digit;
        }
        at += 1 + digits;
    }
    let offset_minutes = zone_at(text, at, true)?;
    Some(Civil {
        year,
        month,
        day,
        hour,
        minute,
        second,
        nanos,
        offset_minutes,
    })
}

const MONTHS: [&[u8]; 12] = [
    b"Jan", b"Feb", b"Mar", b"Apr", b"May", b"Jun", b"Jul", b"Aug", b"Sep", b"Oct", b"Nov", b"Dec",
];

fn parse_common_log(text: &[u8]) -> Option<Civil> {
    let separators = text.get(2) == Some(&b'/')
        && text.get(6) == Some(&b'/')
        && text.get(11) == Some(&b':')
        && text.get(14) == Some(&b':')
        && text.get(17) == Some(&b':')
        && text.get(20) == Some(&b' ');
    if !separators {
        return None;
    }
    let day = digits_at(text, 0, 2)?;
    let month = MONTHS
        .iter()
        .position(|name| text.get(3..6) == Some(*name))?;
    let year = digits_at(text, 7, 4)?;
    let (hour, minute, second) = (
        digits_at(text, 12, 2)?,
        digits_at(text, 15, 2)?,
        digits_at(text, 18, 2)?,
    );
    let offset_minutes = zone_at(text, 21, false)?;
    Some(Civil {
        year,
        month: i64::try_from(month).unwrap_or(0) + 1,
        day,
        hour,
        minute,
        second,
        nanos: 0,
        offset_minutes,
    })
}

fn parse_unix(text: &str, fraction_digits: u32) -> Result<u64, TimeError> {
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    let all_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(whole) || fraction.is_some_and(|f| !all_digits(f)) {
        return Err(TimeError::Format);
    }
    let trimmed = whole.trim_start_matches('0');
    if trimmed.len() > 20 {
        return Err(TimeError::Range);
    }
    let whole: u128 = if trimmed.is_empty() {
        0
    } else {
        trimmed.parse().map_err(|_| TimeError::Range)?
    };
    let mut fraction_value = 0u128;
    let fraction = fraction.unwrap_or_default().as_bytes();
    for index in 0..fraction_digits as usize {
        let digit = fraction.get(index).map_or(0, |b| u128::from(b - b'0'));
        fraction_value = fraction_value * 10 + digit;
    }
    let nanos = whole * 10u128.pow(fraction_digits) + fraction_value;
    u64::try_from(nanos).map_err(|_| TimeError::Range)
}

fn run_timestamp(value: &AnyValue, format: TimestampFormat) -> Outcome {
    let Some(text) = text_of(value) else {
        return Outcome::Failed("source is not text");
    };
    let nanos = match format {
        TimestampFormat::UnixS => parse_unix(&text, 9),
        TimestampFormat::UnixMs => parse_unix(&text, 6),
        TimestampFormat::UnixUs => parse_unix(&text, 3),
        TimestampFormat::UnixNs => parse_unix(&text, 0),
        TimestampFormat::Rfc3339 => parse_rfc3339(text.as_bytes())
            .ok_or(TimeError::Format)
            .and_then(|c| civil_nanos(&c)),
        TimestampFormat::CommonLog => parse_common_log(text.as_bytes())
            .ok_or(TimeError::Format)
            .and_then(|c| civil_nanos(&c)),
    };
    match nanos {
        Ok(nanos) => Outcome::Time(nanos),
        Err(TimeError::Format) => Outcome::FailedOwned(format!("does not match {}", format.name())),
        Err(TimeError::Range) => Outcome::Failed("out of range"),
    }
}

/// Sets an attribute, replacing the first entry with the key; protected keys are never written.
fn set_attribute(attributes: &mut Vec<KeyValue>, key: String, value: AnyValue) -> bool {
    if is_protected_key(&key) {
        return false;
    }
    if let Some(kv) = attributes.iter_mut().find(|kv| kv.key == key) {
        kv.value = Some(value);
    } else {
        attributes.push(KeyValue {
            key,
            value: Some(value),
            ..Default::default()
        });
    }
    true
}

fn source_value<'a>(record: &'a LogRecord, step: &CompiledStep) -> Option<&'a AnyValue> {
    let value = match step.source {
        ParseSource::Body => record.body.as_ref(),
        ParseSource::Attribute => record
            .attributes
            .iter()
            .find(|kv| kv.key == step.key)
            .and_then(|kv| kv.value.as_ref()),
    };
    value.filter(|value| value.value.is_some())
}

/// Runs one rule's steps in order on a log its conditions matched. Keys written from the body
/// are appended to `body_keys`. Returns the first failure (`<step>: <reason>`), also set as
/// `maple.parse.error`.
pub(super) fn run_steps(
    steps: &[CompiledStep],
    record: &mut LogRecord,
    budget: &mut ScanBudget,
    body_keys: &mut Vec<String>,
) -> Option<String> {
    let mut failure = None;
    for step in steps {
        if budget.spent() {
            failure.get_or_insert_with(|| {
                "budget: this rule ran out of time on this batch".to_owned()
            });
            break;
        }
        let outcome = match source_value(record, step) {
            None => Outcome::Failed("source is missing"),
            Some(value) => match &step.kind {
                StepKind::Json { prefix } => run_json(value, prefix, budget),
                StepKind::Pattern { regex, fields, .. } => {
                    run_pattern(regex, fields, value, budget)
                }
                StepKind::Severity => run_severity(value),
                StepKind::Timestamp(format) => run_timestamp(value, *format),
            },
        };
        match outcome {
            Outcome::Failed(reason) => {
                failure.get_or_insert_with(|| format!("{}: {reason}", step.label()));
            }
            Outcome::FailedOwned(reason) => {
                failure.get_or_insert_with(|| format!("{}: {reason}", step.label()));
            }
            Outcome::Severity(number) => {
                record.severity_number = number;
                severity_name(number).clone_into(&mut record.severity_text);
            }
            Outcome::Time(nanos) => record.time_unix_nano = nanos,
            Outcome::Fields(fields) => {
                let prefix = match &step.kind {
                    StepKind::Json { prefix } | StepKind::Pattern { prefix, .. } => prefix.as_str(),
                    StepKind::Severity | StepKind::Timestamp(_) => "",
                };
                // JSON checked this before copying; regex and grok captures are checked here.
                if !matches!(step.kind, StepKind::Json { .. }) {
                    let size = output_size(
                        prefix,
                        fields.iter().map(|(key, value)| (key.as_str(), value)),
                    );
                    budget.charge(size);
                    if size > OUTPUT_BYTES {
                        failure
                            .get_or_insert_with(|| format!("{}: {OUTPUT_FAILURE}", step.label()));
                        continue;
                    }
                }
                for (key, value) in fields {
                    let key = format!("{prefix}{key}");
                    if set_attribute(&mut record.attributes, key.clone(), value)
                        && step.source == ParseSource::Body
                    {
                        body_keys.push(key);
                    }
                }
            }
        }
    }
    if let Some(failure) = &failure {
        set_attribute(
            &mut record.attributes,
            PARSE_ERROR_KEY.to_owned(),
            any(any_value::Value::StringValue(failure.clone())),
        );
    }
    failure
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grok_library_matches_the_shared_table() {
        let shared: serde_json::Map<String, Value> = serde_json::from_str(include_str!(
            "../../../../packages/ingest-rules/fixtures/grok-patterns.json"
        ))
        .expect("grok table parses");
        let ours: serde_json::Map<String, Value> = GROK_PATTERNS
            .iter()
            .map(|(name, definition)| ((*name).to_owned(), Value::String((*definition).to_owned())))
            .collect();
        assert_eq!(ours, shared);
    }

    #[test]
    fn every_grok_pattern_compiles() {
        for (name, _) in GROK_PATTERNS {
            compile_pattern("grok", &format!("%{{{name}:field}}"))
                .unwrap_or_else(|error| panic!("{name}: {error}"));
        }
    }

    #[test]
    fn shorthands_become_ascii_inside_and_outside_classes() {
        assert_eq!(
            ascii_shorthands(r"\d+[\w.]\b"),
            r"[0-9]+[0-9A-Za-z_.](?-u:\b)"
        );
        assert_eq!(ascii_shorthands(r"[\]\d]\\d"), r"[\]0-9]\\d");
        assert_eq!(ascii_shorthands(r"[]\s]"), r"[]\t\n\x0C\r ]");
    }

    #[test]
    fn a_spent_rule_budget_records_a_failure_instead_of_parsing() {
        let steps = compile_steps(vec![ParseStepSpec::Json {
            source: ParseSource::Body,
            key: None,
            prefix: None,
        }])
        .expect("compiles");
        let mut record = LogRecord {
            body: Some(any(any_value::Value::StringValue(r#"{"a":1}"#.to_owned()))),
            ..Default::default()
        };
        let mut budget = ScanBudget::new(0, Duration::from_secs(1));
        let failure = run_steps(&steps, &mut record, &mut budget, &mut Vec::new());
        assert_eq!(
            failure.as_deref(),
            Some("budget: this rule ran out of time on this batch")
        );
        assert_eq!(
            record.attributes.len(),
            1,
            "only the failure is written: {:?}",
            record.attributes
        );
    }
}
