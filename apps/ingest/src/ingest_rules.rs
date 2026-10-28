//! Customer ingest rules: drop or redact telemetry before it is stored or billed.
//! The contract is `docs/ingest-rules.md`; the shared fixtures in
//! `packages/ingest-rules/fixtures/` hold this engine and the TS one to it.

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::sync::LazyLock;

use hmac::{Hmac, Mac};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue, KeyValue};
use opentelemetry_proto::tonic::logs::v1::LogRecord;
use opentelemetry_proto::tonic::metrics::v1::{
    metric, ExponentialHistogramDataPoint, HistogramDataPoint, NumberDataPoint, SummaryDataPoint,
};
use opentelemetry_proto::tonic::resource::v1::Resource;
use opentelemetry_proto::tonic::trace::v1::{span, Span};
use prost::Message;
use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Detectors and patterns read at most this many bytes of one string value.
const SCAN_BYTES: usize = 16 * 1024;
const REGEX_SIZE_LIMIT: usize = 1 << 20;
const MASK: &str = "[REDACTED]";

/// The stored rule's id (any string the caller uses to attribute stats).
pub type RuleId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestSignal {
    Traces,
    Logs,
    Metrics,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionField {
    ServiceName,
    Name,
    Attribute,
    ResourceAttribute,
    Body,
    Severity,
    SpanKind,
    SpanStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionOp {
    Eq,
    Neq,
    In,
    NotIn,
    Prefix,
    Contains,
    Regex,
    Exists,
    NotExists,
    Lt,
    Gte,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionSpec {
    pub field: ConditionField,
    #[serde(default)]
    pub key: Option<String>,
    pub op: ConditionOp,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub values: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Detector {
    Email,
    CreditCard,
    Jwt,
    ApiToken,
    Ipv4,
    Ipv6,
    Phone,
    Iban,
}

impl Detector {
    fn mask(self) -> &'static str {
        match self {
            Self::Email => "[REDACTED:email]",
            Self::CreditCard => "[REDACTED:credit_card]",
            Self::Jwt => "[REDACTED:jwt]",
            Self::ApiToken => "[REDACTED:api_token]",
            Self::Ipv4 => "[REDACTED:ipv4]",
            Self::Ipv6 => "[REDACTED:ipv6]",
            Self::Phone => "[REDACTED:phone]",
            Self::Iban => "[REDACTED:iban]",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactScope {
    Attributes,
    Resource,
    Events,
    Body,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactMethod {
    Mask,
    Hash,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "_tag", rename_all = "snake_case")]
pub enum ActionSpec {
    Drop {
        #[serde(rename = "keepPercent")]
        keep_percent: u8,
    },
    Redact {
        keys: Vec<String>,
        detectors: Vec<Detector>,
        patterns: Vec<String>,
        scopes: Vec<RedactScope>,
        method: RedactMethod,
    },
}

/// The evaluated part of a rule, as `packages/domain/src/ingest-rules.ts` encodes it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestRuleSpec {
    pub signals: Vec<IngestSignal>,
    pub conditions: Vec<ConditionSpec>,
    pub action: ActionSpec,
}

/// A rule that could not be compiled; it is skipped, never applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidRule {
    pub id: RuleId,
    pub reason: String,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RuleCounters {
    /// Records the rule's signals and conditions matched (dropped or not).
    pub matched: u64,
    /// Records this rule dropped (the first dropping rule in list order).
    pub dropped: u64,
    /// Protobuf-encoded bytes of those records.
    pub dropped_bytes: u64,
    /// Values replaced or removed, plus each detector or pattern match.
    pub redacted_values: u64,
}

impl RuleCounters {
    fn add(&mut self, other: &Self) {
        self.matched += other.matched;
        self.dropped += other.dropped;
        self.dropped_bytes += other.dropped_bytes;
        self.redacted_values += other.redacted_values;
    }
}

/// Counters indexed like `CompiledRules::rule_ids()`, plus totals.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RuleStats {
    pub per_rule: Vec<RuleCounters>,
    pub total: RuleCounters,
}

impl RuleStats {
    fn ensure(&mut self, len: usize) {
        if self.per_rule.len() < len {
            self.per_rule.resize(len, RuleCounters::default());
        }
    }

    fn refresh_total(&mut self) {
        let mut total = RuleCounters::default();
        for counters in &self.per_rule {
            total.add(counters);
        }
        self.total = total;
    }
}

const SIGNAL_TRACES: u8 = 1;
const SIGNAL_LOGS: u8 = 1 << 1;
const SIGNAL_METRICS: u8 = 1 << 2;

const SCOPE_ATTRIBUTES: u8 = 1;
const SCOPE_RESOURCE: u8 = 1 << 1;
const SCOPE_EVENTS: u8 = 1 << 2;
const SCOPE_BODY: u8 = 1 << 3;

fn signal_bit(signal: IngestSignal) -> u8 {
    match signal {
        IngestSignal::Traces => SIGNAL_TRACES,
        IngestSignal::Logs => SIGNAL_LOGS,
        IngestSignal::Metrics => SIGNAL_METRICS,
    }
}

fn scope_bit(scope: RedactScope) -> u8 {
    match scope {
        RedactScope::Attributes => SCOPE_ATTRIBUTES,
        RedactScope::Resource => SCOPE_RESOURCE,
        RedactScope::Events => SCOPE_EVENTS,
        RedactScope::Body => SCOPE_BODY,
    }
}

#[derive(Debug)]
enum Operand {
    None,
    Text(String),
    List(Vec<String>),
    Pattern(Regex),
    Severity(i32),
}

#[derive(Debug)]
struct CompiledCondition {
    field: ConditionField,
    key: String,
    op: ConditionOp,
    operand: Operand,
}

/// A case-insensitive key glob: `*` matches any run of characters.
#[derive(Debug)]
struct KeyGlob {
    /// The lower-cased pattern split on `*`; one segment means an exact key.
    segments: Vec<String>,
}

impl KeyGlob {
    fn new(pattern: &str) -> Self {
        let lower = pattern.to_lowercase();
        Self {
            segments: lower.split('*').map(str::to_owned).collect(),
        }
    }

    fn matches(&self, key: &str) -> bool {
        let segments = &self.segments;
        let (Some(first), Some(last)) = (segments.first(), segments.last()) else {
            return false;
        };
        if segments.len() == 1 {
            return key == first;
        }
        if key.len() < first.len() + last.len()
            || !key.starts_with(first.as_str())
            || !key.ends_with(last.as_str())
        {
            return false;
        }
        let mut rest = &key[first.len()..key.len() - last.len()];
        for segment in &segments[1..segments.len() - 1] {
            if segment.is_empty() {
                continue;
            }
            match rest.find(segment.as_str()) {
                Some(at) => rest = &rest[at + segment.len()..],
                None => return false,
            }
        }
        true
    }
}

#[derive(Debug)]
struct Redaction {
    keys: Vec<KeyGlob>,
    detectors: Vec<Detector>,
    patterns: Vec<Regex>,
    scopes: u8,
    method: RedactMethod,
}

#[derive(Debug)]
enum CompiledAction {
    Drop { keep_percent: u8 },
    Redact(Redaction),
}

#[derive(Debug)]
struct CompiledRule {
    signals: u8,
    conditions: Vec<CompiledCondition>,
    action: CompiledAction,
}

/// One org's rules, compiled once and applied to every request.
#[derive(Debug, Default)]
pub struct CompiledRules {
    ids: Vec<RuleId>,
    rules: Vec<CompiledRule>,
    /// Union of every rule's signal bits, so a signal no rule reads is skipped.
    signals: u8,
    hash_salt: String,
}

fn build_regex(pattern: &str) -> Result<Regex, String> {
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|error| format!("invalid regex {pattern:?}: {error}"))
}

fn severity_level(name: &str) -> Option<i32> {
    match name {
        "trace" => Some(1),
        "debug" => Some(5),
        "info" => Some(9),
        "warn" => Some(13),
        "error" => Some(17),
        "fatal" => Some(21),
        _ => None,
    }
}

fn compile_condition(spec: ConditionSpec) -> Result<CompiledCondition, String> {
    let operand = match spec.op {
        ConditionOp::Exists | ConditionOp::NotExists => Operand::None,
        ConditionOp::In | ConditionOp::NotIn => Operand::List(
            spec.values
                .ok_or_else(|| format!("{:?} needs values", spec.op))?,
        ),
        ConditionOp::Lt | ConditionOp::Gte => {
            let name = spec.value.ok_or("severity needs a value")?;
            Operand::Severity(
                severity_level(&name).ok_or_else(|| format!("unknown severity {name:?}"))?,
            )
        }
        ConditionOp::Regex => {
            Operand::Pattern(build_regex(&spec.value.ok_or("regex needs a value")?)?)
        }
        ConditionOp::Eq | ConditionOp::Neq | ConditionOp::Prefix | ConditionOp::Contains => {
            Operand::Text(spec.value.ok_or_else(|| format!("{:?} needs a value", spec.op))?)
        }
    };
    Ok(CompiledCondition {
        field: spec.field,
        key: spec.key.unwrap_or_default(),
        op: spec.op,
        operand,
    })
}

fn compile_rule(spec: IngestRuleSpec) -> Result<CompiledRule, String> {
    let signals = spec.signals.iter().fold(0, |bits, s| bits | signal_bit(*s));
    let conditions = spec
        .conditions
        .into_iter()
        .map(compile_condition)
        .collect::<Result<Vec<_>, _>>()?;
    let action = match spec.action {
        ActionSpec::Drop { keep_percent } => CompiledAction::Drop {
            keep_percent: keep_percent.min(100),
        },
        ActionSpec::Redact {
            keys,
            detectors,
            patterns,
            scopes,
            method,
        } => CompiledAction::Redact(Redaction {
            keys: keys.iter().map(|key| KeyGlob::new(key)).collect(),
            detectors,
            patterns: patterns
                .iter()
                .map(|pattern| build_regex(pattern))
                .collect::<Result<Vec<_>, _>>()?,
            scopes: scopes.iter().fold(0, |bits, s| bits | scope_bit(*s)),
            method,
        }),
    };
    Ok(CompiledRule {
        signals,
        conditions,
        action,
    })
}

impl CompiledRules {
    /// Compiles rules in `position` order; a rule that fails to compile is reported and skipped.
    pub fn compile(
        rules: Vec<(RuleId, IngestRuleSpec)>,
        hash_salt: String,
    ) -> (Self, Vec<InvalidRule>) {
        let mut compiled = Self {
            hash_salt,
            ..Self::default()
        };
        let mut invalid = Vec::new();
        for (id, spec) in rules {
            match compile_rule(spec) {
                Ok(rule) => {
                    compiled.signals |= rule.signals;
                    compiled.rules.push(rule);
                    compiled.ids.push(id);
                }
                Err(reason) => invalid.push(InvalidRule { id, reason }),
            }
        }
        (compiled, invalid)
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    pub fn len(&self) -> usize {
        self.rules.len()
    }

    /// Ids of the compiled rules; `RuleStats::per_rule` uses the same indexes.
    pub fn rule_ids(&self) -> &[RuleId] {
        &self.ids
    }

    fn reads(&self, signal: u8) -> bool {
        self.signals & signal != 0
    }
}

/// What a condition reads from one record, borrowed as received.
struct RecordView<'a> {
    resource: &'a [KeyValue],
    attributes: &'a [KeyValue],
    name: Option<&'a str>,
    body: Option<&'a AnyValue>,
    severity: Option<i32>,
    span_kind: Option<&'static str>,
    span_status: Option<&'static str>,
    trace_id: &'a [u8],
}

/// A value as a condition sees it.
enum Probe<'a> {
    Missing,
    /// Present, but bytes, an array or a kvlist: only `exists` matches it.
    Opaque,
    Text(Cow<'a, str>),
}

/// Rust's `{}` form: no exponent, `-0`, `inf`, `NaN` (the TS engine's `formatDouble` matches it).
fn format_double(value: f64) -> String {
    format!("{value}")
}

fn probe_value(value: Option<&AnyValue>) -> Probe<'_> {
    match value.and_then(|v| v.value.as_ref()) {
        Some(any_value::Value::StringValue(text)) => Probe::Text(Cow::Borrowed(text.as_str())),
        Some(any_value::Value::IntValue(int)) => Probe::Text(Cow::Owned(int.to_string())),
        Some(any_value::Value::BoolValue(flag)) => {
            Probe::Text(Cow::Borrowed(if *flag { "true" } else { "false" }))
        }
        Some(any_value::Value::DoubleValue(double)) => Probe::Text(Cow::Owned(format_double(*double))),
        _ => Probe::Opaque,
    }
}

fn find_attribute<'a>(attributes: &'a [KeyValue], key: &str) -> Probe<'a> {
    match attributes.iter().find(|kv| kv.key == key) {
        Some(kv) => probe_value(kv.value.as_ref()),
        None => Probe::Missing,
    }
}

fn severity_from_text(text: &str) -> Option<i32> {
    let lower = text.to_ascii_lowercase();
    [
        ("trace", 1),
        ("debug", 5),
        ("info", 9),
        ("warn", 13),
        ("err", 17),
        ("fatal", 21),
        ("crit", 21),
        ("emerg", 21),
    ]
    .iter()
    .find(|(prefix, _)| lower.starts_with(prefix))
    .map(|(_, level)| *level)
}

fn log_severity(record: &LogRecord) -> Option<i32> {
    if record.severity_number > 0 {
        Some(record.severity_number)
    } else {
        severity_from_text(&record.severity_text)
    }
}

fn span_kind_name(kind: i32) -> Option<&'static str> {
    match kind {
        0 => Some("unspecified"),
        1 => Some("internal"),
        2 => Some("server"),
        3 => Some("client"),
        4 => Some("producer"),
        5 => Some("consumer"),
        _ => None,
    }
}

fn span_status_name(span: &Span) -> Option<&'static str> {
    match span.status.as_ref().map_or(0, |status| status.code) {
        0 => Some("unset"),
        1 => Some("ok"),
        2 => Some("error"),
        _ => None,
    }
}

fn borrowed(text: Option<&str>) -> Probe<'_> {
    text.map_or(Probe::Missing, |t| Probe::Text(Cow::Borrowed(t)))
}

impl CompiledCondition {
    fn matches(&self, record: &RecordView<'_>) -> bool {
        let probe = match self.field {
            ConditionField::ServiceName => match find_attribute(record.resource, "service.name") {
                Probe::Missing => Probe::Text(Cow::Borrowed("")),
                found => found,
            },
            ConditionField::Name => borrowed(record.name),
            ConditionField::Attribute => find_attribute(record.attributes, &self.key),
            ConditionField::ResourceAttribute => find_attribute(record.resource, &self.key),
            ConditionField::Body => match record.body {
                Some(body) if body.value.is_some() => probe_value(Some(body)),
                _ => Probe::Missing,
            },
            ConditionField::Severity => return self.matches_severity(record.severity),
            ConditionField::SpanKind => borrowed(record.span_kind),
            ConditionField::SpanStatus => borrowed(record.span_status),
        };
        self.matches_probe(&probe)
    }

    fn matches_severity(&self, severity: Option<i32>) -> bool {
        let (Some(severity), Operand::Severity(level)) = (severity, &self.operand) else {
            return false;
        };
        match self.op {
            ConditionOp::Lt => severity < *level,
            ConditionOp::Gte => severity >= *level,
            _ => false,
        }
    }

    fn matches_probe(&self, probe: &Probe<'_>) -> bool {
        let text: &str = match probe {
            Probe::Missing => {
                return matches!(
                    self.op,
                    ConditionOp::Neq | ConditionOp::NotIn | ConditionOp::NotExists
                )
            }
            Probe::Opaque => return self.op == ConditionOp::Exists,
            Probe::Text(text) => text,
        };
        match (&self.operand, self.op) {
            (_, ConditionOp::Exists) => true,
            (Operand::Text(value), ConditionOp::Eq) => text == value.as_str(),
            (Operand::Text(value), ConditionOp::Neq) => text != value.as_str(),
            (Operand::Text(value), ConditionOp::Prefix) => text.starts_with(value.as_str()),
            (Operand::Text(value), ConditionOp::Contains) => text.contains(value.as_str()),
            (Operand::List(values), ConditionOp::In) => values.iter().any(|v| v == text),
            (Operand::List(values), ConditionOp::NotIn) => !values.iter().any(|v| v == text),
            (Operand::Pattern(pattern), ConditionOp::Regex) => {
                pattern.is_match(&text[..floor_char_boundary(text, SCAN_BYTES)])
            }
            _ => false,
        }
    }
}

impl CompiledRule {
    fn matches(&self, signal: u8, record: &RecordView<'_>) -> bool {
        self.signals & signal != 0 && self.conditions.iter().all(|c| c.matches(record))
    }
}

fn push_hex(out: &mut String, bytes: &[u8]) {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
}

thread_local! {
    static SAMPLE_STATE: Cell<u64> = Cell::new(RandomState::new().hash_one(0x9e37_79b9_u64));
}

/// splitmix64 over a randomly seeded per-thread state; sampling only, not crypto.
fn random_u64() -> u64 {
    SAMPLE_STATE.with(|state| {
        let next = state.get().wrapping_add(0x9e37_79b9_7f4a_7c15);
        state.set(next);
        let mut z = next;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    })
}

/// The record's sampling bucket in 0..100: stable per trace id, random without one.
fn sample_bucket(trace_id: &[u8]) -> u64 {
    if trace_id.is_empty() {
        return random_u64() % 100;
    }
    let mut hex = String::with_capacity(trace_id.len() * 2);
    push_hex(&mut hex, trace_id);
    let digest = Sha256::digest(hex.as_bytes());
    let mut head = [0u8; 8];
    head.copy_from_slice(&digest[..8]);
    u64::from_be_bytes(head) % 100
}

const EMAIL: &str =
    r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}";
const CREDIT_CARD: &str = r"[0-9](?:[ -]?[0-9]){12,18}";
const JWT: &str = r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*";
const API_TOKEN: &str = r"(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|[Bb]earer [A-Za-z0-9._~+/=-]{8,}";
const IPV4: &str = r"(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV6: &str = r"[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}";
const PHONE: &str =
    r"\+[0-9][0-9 ().-]{6,18}[0-9]|\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}";
const IBAN: &str = r"[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?";

#[expect(
    clippy::expect_used,
    reason = "detector patterns are constants covered by the fixture tests"
)]
fn static_regex(pattern: &str) -> Regex {
    build_regex(pattern).expect("detector pattern compiles")
}

static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| static_regex(EMAIL));
static CREDIT_CARD_RE: LazyLock<Regex> = LazyLock::new(|| static_regex(CREDIT_CARD));
static JWT_RE: LazyLock<Regex> = LazyLock::new(|| static_regex(JWT));
static API_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| static_regex(API_TOKEN));
static IPV4_RE: LazyLock<Regex> = LazyLock::new(|| static_regex(IPV4));
static IPV6_RE: LazyLock<Regex> = LazyLock::new(|| static_regex(IPV6));
static PHONE_RE: LazyLock<Regex> = LazyLock::new(|| static_regex(PHONE));
static IBAN_RE: LazyLock<Regex> = LazyLock::new(|| static_regex(IBAN));

fn detector_regex(detector: Detector) -> &'static Regex {
    match detector {
        Detector::Email => &EMAIL_RE,
        Detector::CreditCard => &CREDIT_CARD_RE,
        Detector::Jwt => &JWT_RE,
        Detector::ApiToken => &API_TOKEN_RE,
        Detector::Ipv4 => &IPV4_RE,
        Detector::Ipv6 => &IPV6_RE,
        Detector::Phone => &PHONE_RE,
        Detector::Iban => &IBAN_RE,
    }
}

/// The characters right before and after the match are not ASCII letters or digits.
fn bounded(text: &[u8], start: usize, end: usize) -> bool {
    let before = start.checked_sub(1).and_then(|i| text.get(i));
    let after = text.get(end);
    !before.is_some_and(u8::is_ascii_alphanumeric) && !after.is_some_and(u8::is_ascii_alphanumeric)
}

fn digit_count(text: &str) -> usize {
    text.bytes().filter(u8::is_ascii_digit).count()
}

fn luhn(text: &str) -> bool {
    let mut sum = 0u32;
    for (index, byte) in text.bytes().rev().filter(u8::is_ascii_digit).enumerate() {
        let mut digit = u32::from(byte - b'0');
        if index % 2 == 1 {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
    }
    sum % 10 == 0
}

fn iban_mod97(text: &str) -> bool {
    let compact: Vec<u8> = text.bytes().filter(|b| *b != b' ').collect();
    if compact.len() < 5 {
        return false;
    }
    let mut remainder = 0u32;
    for byte in compact[4..].iter().chain(&compact[..4]) {
        remainder = match byte {
            b'0'..=b'9' => (remainder * 10 + u32::from(byte - b'0')) % 97,
            b'A'..=b'Z' => (remainder * 100 + u32::from(byte - b'A') + 10) % 97,
            _ => return false,
        };
    }
    remainder == 1
}

fn ipv6_shape(candidate: &str) -> bool {
    let colons = candidate.bytes().filter(|b| *b == b':').count();
    let double = candidate.matches("::").count();
    let shape = (double == 1 && colons <= 7) || (colons == 7 && double == 0);
    shape && candidate.bytes().any(|b| b.is_ascii_hexdigit())
}

/// The post-check a detector candidate must pass to be redacted.
fn detector_accepts(detector: Detector, text: &str, start: usize, end: usize) -> bool {
    let bytes = text.as_bytes();
    let candidate = &text[start..end];
    match detector {
        Detector::Email | Detector::Jwt => true,
        Detector::CreditCard => {
            let digits = digit_count(candidate);
            bounded(bytes, start, end) && (13..=19).contains(&digits) && luhn(candidate)
        }
        Detector::ApiToken => bounded(bytes, start, end),
        Detector::Ipv4 => {
            let before_dot = start > 0 && bytes[start - 1] == b'.';
            let after_dot = bytes.get(end) == Some(&b'.')
                && bytes.get(end + 1).is_some_and(u8::is_ascii_digit);
            bounded(bytes, start, end) && !before_dot && !after_dot
        }
        Detector::Ipv6 => {
            let before_colon = start > 0 && bytes[start - 1] == b':';
            let after_colon = bytes.get(end) == Some(&b':');
            bounded(bytes, start, end) && !before_colon && !after_colon && ipv6_shape(candidate)
        }
        Detector::Phone => {
            bounded(bytes, start, end) && (10..=15).contains(&digit_count(candidate))
        }
        Detector::Iban => bounded(bytes, start, end) && iban_mod97(candidate),
    }
}

fn hash_text(salt: &[u8], text: &str) -> String {
    let mut mac = new_mac(salt);
    mac.update(text.as_bytes());
    let digest = mac.finalize().into_bytes();
    let mut out = String::with_capacity(21);
    out.push_str("hash:");
    push_hex(&mut out, &digest[..8]);
    out
}

#[expect(
    clippy::expect_used,
    reason = "HMAC accepts keys of any length, so `new_from_slice` cannot fail here"
)]
fn new_mac(salt: &[u8]) -> HmacSha256 {
    HmacSha256::new_from_slice(salt).expect("hmac accepts any key length")
}

fn floor_char_boundary(text: &str, max: usize) -> usize {
    if max >= text.len() {
        return text.len();
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    cut
}

/// The gateway's own routing and billing stamps; dotted keys like `maple_ai.*` carry customer text.
fn is_protected_key(key: &str) -> bool {
    key == "service.name"
        || key == "org_id"
        || key.strip_prefix("maple_").is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        })
}

fn string_value(text: String) -> Option<AnyValue> {
    Some(AnyValue {
        value: Some(any_value::Value::StringValue(text)),
    })
}

fn lowercase_key(key: &str) -> Cow<'_, str> {
    if key.is_ascii() && !key.bytes().any(|b| b.is_ascii_uppercase()) {
        Cow::Borrowed(key)
    } else {
        Cow::Owned(key.to_lowercase())
    }
}

/// One redact rule applied to the values of one record.
struct Redactor<'a> {
    redaction: &'a Redaction,
    salt: &'a [u8],
    /// Values replaced or removed plus detector and pattern matches.
    count: u64,
}

impl Redactor<'_> {
    fn scans_text(&self) -> bool {
        !self.redaction.detectors.is_empty() || !self.redaction.patterns.is_empty()
    }

    fn key_matches(&self, key: &str) -> bool {
        if self.redaction.keys.is_empty() {
            return false;
        }
        let lower = lowercase_key(key);
        self.redaction.keys.iter().any(|glob| glob.matches(&lower))
    }

    fn replacement(&self, label: &'static str, matched: &str) -> Cow<'static, str> {
        match self.redaction.method {
            RedactMethod::Hash => Cow::Owned(hash_text(self.salt, matched)),
            RedactMethod::Mask | RedactMethod::Remove => Cow::Borrowed(label),
        }
    }

    /// Redacts attributes or kvlist entries in place.
    fn redact_attributes(&mut self, attributes: &mut Vec<KeyValue>) {
        attributes.retain_mut(|kv| self.redact_entry(kv));
    }

    /// Returns false when the entry is to be removed.
    fn redact_entry(&mut self, kv: &mut KeyValue) -> bool {
        if is_protected_key(&kv.key) {
            return true;
        }
        if self.key_matches(&kv.key) {
            self.count += 1;
            match self.redaction.method {
                RedactMethod::Remove => return false,
                RedactMethod::Mask => kv.value = string_value(MASK.to_owned()),
                RedactMethod::Hash => {
                    let hashed = match kv.value.as_ref().and_then(|v| v.value.as_ref()) {
                        Some(any_value::Value::StringValue(text)) => hash_text(self.salt, text),
                        _ => MASK.to_owned(),
                    };
                    kv.value = string_value(hashed);
                }
            }
            return true;
        }
        if let Some(value) = kv.value.as_mut() {
            self.redact_value(value);
        }
        true
    }

    /// Searches a value recursively; only kvlist entries have keys.
    fn redact_value(&mut self, value: &mut AnyValue) {
        match value.value.as_mut() {
            Some(any_value::Value::StringValue(text)) => self.scan_string(text),
            Some(any_value::Value::ArrayValue(array)) => {
                for item in &mut array.values {
                    self.redact_value(item);
                }
            }
            Some(any_value::Value::KvlistValue(list)) => self.redact_attributes(&mut list.values),
            _ => {}
        }
    }

    /// Runs detectors then patterns over the first `SCAN_BYTES` of the string.
    fn scan_string(&mut self, text: &mut String) {
        if !self.scans_text() {
            return;
        }
        let redaction = self.redaction;
        let cut = floor_char_boundary(text, SCAN_BYTES);
        let rewritten = {
            let mut head: Cow<'_, str> = Cow::Borrowed(&text[..cut]);
            for detector in &redaction.detectors {
                if let Some(next) = self.replace_detector(*detector, &head) {
                    head = Cow::Owned(next);
                }
            }
            for pattern in &redaction.patterns {
                if let Some(next) = self.replace_pattern(pattern, &head) {
                    head = Cow::Owned(next);
                }
            }
            match head {
                Cow::Owned(head) => Some(head),
                Cow::Borrowed(_) => None,
            }
        };
        if let Some(mut head) = rewritten {
            head.push_str(&text[cut..]);
            *text = head;
        }
    }

    /// Replaces accepted detector candidates; a rejected one resumes the search one byte later.
    fn replace_detector(&mut self, detector: Detector, text: &str) -> Option<String> {
        let regex = detector_regex(detector);
        let mut out: Option<String> = None;
        let mut copied = 0;
        let mut position = 0;
        while position <= text.len() {
            let Some(found) = regex.find_at(text, position) else {
                break;
            };
            let (start, end) = (found.start(), found.end());
            if start < end && detector_accepts(detector, text, start, end) {
                let buffer = out.get_or_insert_with(|| String::with_capacity(text.len()));
                buffer.push_str(&text[copied..start]);
                buffer.push_str(&self.replacement(detector.mask(), found.as_str()));
                self.count += 1;
                copied = end;
                position = end;
            } else {
                position = start + 1;
                while position < text.len() && !text.is_char_boundary(position) {
                    position += 1;
                }
            }
        }
        out.map(|mut buffer| {
            buffer.push_str(&text[copied..]);
            buffer
        })
    }

    /// Plain leftmost-first, non-overlapping replacement; empty matches are ignored.
    fn replace_pattern(&mut self, pattern: &Regex, text: &str) -> Option<String> {
        let mut out: Option<String> = None;
        let mut copied = 0;
        for found in pattern.find_iter(text) {
            if found.start() == found.end() {
                continue;
            }
            let buffer = out.get_or_insert_with(|| String::with_capacity(text.len()));
            buffer.push_str(&text[copied..found.start()]);
            buffer.push_str(&self.replacement(MASK, found.as_str()));
            self.count += 1;
            copied = found.end();
        }
        out.map(|mut buffer| {
            buffer.push_str(&text[copied..]);
            buffer
        })
    }
}

/// The parts of a surviving record redact rules may change.
struct RecordTargets<'a> {
    attributes: &'a mut Vec<KeyValue>,
    events: &'a mut [span::Event],
    body: Option<&'a mut AnyValue>,
    /// Span status message, scanned under the `attributes` scope.
    status_message: Option<&'a mut String>,
}

/// One `apply_*` call: scratch space reused across records plus the stats sink.
struct Pass<'a> {
    rules: &'a CompiledRules,
    signal: u8,
    stats: &'a mut RuleStats,
    /// Rules the current record matched, as received.
    matched: Vec<bool>,
    /// Resource-scoped redact rules a surviving record of the current resource matched.
    resource_hits: Vec<bool>,
}

impl<'a> Pass<'a> {
    fn new(rules: &'a CompiledRules, signal: u8, stats: &'a mut RuleStats) -> Self {
        stats.ensure(rules.len());
        Self {
            rules,
            signal,
            stats,
            matched: vec![false; rules.len()],
            resource_hits: vec![false; rules.len()],
        }
    }

    /// Records which rules match and decides the drop; returns (keep, any redact rule matched).
    fn evaluate(&mut self, view: &RecordView<'_>, encoded_len: impl FnOnce() -> usize) -> (bool, bool) {
        let mut any_redact = false;
        let mut dropped_by = None;
        let mut bucket = None;
        for (index, rule) in self.rules.rules.iter().enumerate() {
            let hit = rule.matches(self.signal, view);
            self.matched[index] = hit;
            if !hit {
                continue;
            }
            self.stats.per_rule[index].matched += 1;
            match rule.action {
                CompiledAction::Redact(_) => any_redact = true,
                CompiledAction::Drop { keep_percent } if dropped_by.is_none() => {
                    let keep_percent = if self.signal == SIGNAL_METRICS { 0 } else { keep_percent };
                    let keeps = keep_percent >= 100
                        || (keep_percent > 0
                            && *bucket.get_or_insert_with(|| sample_bucket(view.trace_id))
                                < u64::from(keep_percent));
                    if !keeps {
                        dropped_by = Some(index);
                    }
                }
                CompiledAction::Drop { .. } => {}
            }
        }
        if let Some(index) = dropped_by {
            let counters = &mut self.stats.per_rule[index];
            counters.dropped += 1;
            counters.dropped_bytes += u64::try_from(encoded_len()).unwrap_or(u64::MAX);
            return (false, false);
        }
        (true, any_redact)
    }

    /// Applies the matched redact rules in order to a surviving record.
    fn redact_record(&mut self, mut targets: RecordTargets<'_>) {
        let rules = self.rules;
        for (index, rule) in rules.rules.iter().enumerate() {
            let CompiledAction::Redact(redaction) = &rule.action else {
                continue;
            };
            if !self.matched[index] {
                continue;
            }
            let mut redactor = Redactor {
                redaction,
                salt: rules.hash_salt.as_bytes(),
                count: 0,
            };
            if redaction.scopes & SCOPE_ATTRIBUTES != 0 {
                redactor.redact_attributes(targets.attributes);
                if let Some(message) = targets.status_message.as_deref_mut() {
                    redactor.scan_string(message);
                }
            }
            if redaction.scopes & SCOPE_EVENTS != 0 {
                targets
                    .events
                    .iter_mut()
                    .for_each(|event| redactor.redact_attributes(&mut event.attributes));
            }
            if redaction.scopes & SCOPE_BODY != 0 {
                if let Some(body) = targets.body.as_deref_mut() {
                    redactor.redact_value(body);
                }
            }
            if redaction.scopes & SCOPE_RESOURCE != 0 {
                self.resource_hits[index] = true;
            }
            self.stats.per_rule[index].redacted_values += redactor.count;
        }
    }

    /// Redacts the resource once all its records were evaluated, so conditions saw it as received.
    fn finish_resource(&mut self, mut resource: Option<&mut Vec<KeyValue>>) {
        let rules = self.rules;
        for (index, rule) in rules.rules.iter().enumerate() {
            if !std::mem::take(&mut self.resource_hits[index]) {
                continue;
            }
            let (CompiledAction::Redact(redaction), Some(attributes)) =
                (&rule.action, resource.as_deref_mut())
            else {
                continue;
            };
            let mut redactor = Redactor {
                redaction,
                salt: rules.hash_salt.as_bytes(),
                count: 0,
            };
            redactor.redact_attributes(attributes);
            self.stats.per_rule[index].redacted_values += redactor.count;
        }
    }
}

/// The metric data point kinds, which share only their attributes.
trait DataPoint: Message {
    fn attributes(&self) -> &[KeyValue];
    fn attributes_mut(&mut self) -> &mut Vec<KeyValue>;
}

macro_rules! impl_data_point {
    ($($point:ty),*) => {
        $(impl DataPoint for $point {
            fn attributes(&self) -> &[KeyValue] {
                &self.attributes
            }
            fn attributes_mut(&mut self) -> &mut Vec<KeyValue> {
                &mut self.attributes
            }
        })*
    };
}

impl_data_point!(
    NumberDataPoint,
    HistogramDataPoint,
    ExponentialHistogramDataPoint,
    SummaryDataPoint
);

impl Pass<'_> {
    /// Returns false when the span is dropped.
    fn span(&mut self, resource: &[KeyValue], span: &mut Span) -> bool {
        let view = RecordView {
            resource,
            attributes: &span.attributes,
            name: Some(&span.name),
            body: None,
            severity: None,
            span_kind: span_kind_name(span.kind),
            span_status: span_status_name(span),
            trace_id: &span.trace_id,
        };
        let (keep, redact) = self.evaluate(&view, || span.encoded_len());
        if redact {
            self.redact_record(RecordTargets {
                attributes: &mut span.attributes,
                events: &mut span.events,
                body: None,
                status_message: span.status.as_mut().map(|status| &mut status.message),
            });
        }
        keep
    }

    /// Returns false when the log record is dropped.
    fn log(&mut self, resource: &[KeyValue], record: &mut LogRecord) -> bool {
        let view = RecordView {
            resource,
            attributes: &record.attributes,
            name: None,
            body: record.body.as_ref(),
            severity: log_severity(record),
            span_kind: None,
            span_status: None,
            trace_id: &record.trace_id,
        };
        let (keep, redact) = self.evaluate(&view, || record.encoded_len());
        if redact {
            self.redact_record(RecordTargets {
                attributes: &mut record.attributes,
                events: &mut [],
                body: record.body.as_mut(),
                status_message: None,
            });
        }
        keep
    }

    /// Returns false when the data point is dropped.
    fn point<P: DataPoint>(&mut self, resource: &[KeyValue], name: &str, point: &mut P) -> bool {
        let view = RecordView {
            resource,
            attributes: point.attributes(),
            name: Some(name),
            body: None,
            severity: None,
            span_kind: None,
            span_status: None,
            trace_id: &[],
        };
        let (keep, redact) = self.evaluate(&view, || point.encoded_len());
        if redact {
            self.redact_record(RecordTargets {
                attributes: point.attributes_mut(),
                events: &mut [],
                body: None,
                status_message: None,
            });
        }
        keep
    }

    /// Filters one metric's data points; false when a non-empty metric was emptied.
    fn points<P: DataPoint>(&mut self, resource: &[KeyValue], name: &str, points: &mut Vec<P>) -> bool {
        let before = points.len();
        points.retain_mut(|point| self.point(resource, name, point));
        before == 0 || !points.is_empty()
    }
}

/// Keeps a container unless this pass emptied it.
fn still_populated(before: usize, after: usize) -> bool {
    before == 0 || after > 0
}

fn resource_attributes(resource: Option<&Resource>) -> &[KeyValue] {
    match resource {
        Some(resource) => &resource.attributes,
        None => &[],
    }
}

/// Drops and redacts spans in place, then removes emptied scopes and resources.
#[hotpath::measure]
pub fn apply_traces(rules: &CompiledRules, request: &mut ExportTraceServiceRequest, stats: &mut RuleStats) {
    if !rules.reads(SIGNAL_TRACES) {
        return;
    }
    let mut pass = Pass::new(rules, SIGNAL_TRACES, stats);
    request.resource_spans.retain_mut(|resource_spans| {
        let resource = resource_attributes(resource_spans.resource.as_ref());
        let scopes_before = resource_spans.scope_spans.len();
        resource_spans.scope_spans.retain_mut(|scope_spans| {
            let before = scope_spans.spans.len();
            scope_spans.spans.retain_mut(|span| pass.span(resource, span));
            still_populated(before, scope_spans.spans.len())
        });
        pass.finish_resource(resource_spans.resource.as_mut().map(|r| &mut r.attributes));
        still_populated(scopes_before, resource_spans.scope_spans.len())
    });
    pass.stats.refresh_total();
}

/// Drops and redacts log records in place, then removes emptied scopes and resources.
#[hotpath::measure]
pub fn apply_logs(rules: &CompiledRules, request: &mut ExportLogsServiceRequest, stats: &mut RuleStats) {
    if !rules.reads(SIGNAL_LOGS) {
        return;
    }
    let mut pass = Pass::new(rules, SIGNAL_LOGS, stats);
    request.resource_logs.retain_mut(|resource_logs| {
        let resource = resource_attributes(resource_logs.resource.as_ref());
        let scopes_before = resource_logs.scope_logs.len();
        resource_logs.scope_logs.retain_mut(|scope_logs| {
            let before = scope_logs.log_records.len();
            scope_logs.log_records.retain_mut(|record| pass.log(resource, record));
            still_populated(before, scope_logs.log_records.len())
        });
        pass.finish_resource(resource_logs.resource.as_mut().map(|r| &mut r.attributes));
        still_populated(scopes_before, resource_logs.scope_logs.len())
    });
    pass.stats.refresh_total();
}

/// Drops and redacts metric data points in place, then removes emptied metrics, scopes and resources.
#[hotpath::measure]
pub fn apply_metrics(rules: &CompiledRules, request: &mut ExportMetricsServiceRequest, stats: &mut RuleStats) {
    if !rules.reads(SIGNAL_METRICS) {
        return;
    }
    let mut pass = Pass::new(rules, SIGNAL_METRICS, stats);
    request.resource_metrics.retain_mut(|resource_metrics| {
        let resource = resource_attributes(resource_metrics.resource.as_ref());
        let scopes_before = resource_metrics.scope_metrics.len();
        resource_metrics.scope_metrics.retain_mut(|scope_metrics| {
            let before = scope_metrics.metrics.len();
            scope_metrics.metrics.retain_mut(|metric| {
                let name = metric.name.as_str();
                match metric.data.as_mut() {
                    Some(metric::Data::Gauge(gauge)) => pass.points(resource, name, &mut gauge.data_points),
                    Some(metric::Data::Sum(sum)) => pass.points(resource, name, &mut sum.data_points),
                    Some(metric::Data::Histogram(histogram)) => {
                        pass.points(resource, name, &mut histogram.data_points)
                    }
                    Some(metric::Data::ExponentialHistogram(histogram)) => {
                        pass.points(resource, name, &mut histogram.data_points)
                    }
                    Some(metric::Data::Summary(summary)) => pass.points(resource, name, &mut summary.data_points),
                    None => true,
                }
            });
            still_populated(before, scope_metrics.metrics.len())
        });
        pass.finish_resource(resource_metrics.resource.as_mut().map(|r| &mut r.attributes));
        still_populated(scopes_before, resource_metrics.scope_metrics.len())
    });
    pass.stats.refresh_total();
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::common::v1::{ArrayValue, InstrumentationScope, KeyValueList};
    use opentelemetry_proto::tonic::logs::v1::{ResourceLogs, ScopeLogs};
    use opentelemetry_proto::tonic::metrics::v1::{
        number_data_point, Gauge, Metric, ResourceMetrics, ScopeMetrics, Sum,
    };
    use opentelemetry_proto::tonic::trace::v1::{ResourceSpans, ScopeSpans, Status};
    use serde_json::{json, Map, Value};

    const DROP_FIXTURES: &str = include_str!("../../../packages/ingest-rules/fixtures/drop.json");
    const REDACT_FIXTURES: &str =
        include_str!("../../../packages/ingest-rules/fixtures/redact.json");
    const SPAN_KINDS: [&str; 6] = ["unspecified", "internal", "server", "client", "producer", "consumer"];
    const SPAN_STATUSES: [&str; 3] = ["unset", "ok", "error"];

    #[derive(Debug, Deserialize)]
    struct Case {
        name: String,
        salt: String,
        rules: Vec<IngestRuleSpec>,
        input: Input,
        expected: Value,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        signal: IngestSignal,
        resource: Map<String, Value>,
        attributes: Map<String, Value>,
        #[serde(default)]
        body: Option<Value>,
        #[serde(default)]
        severity_number: Option<i32>,
        #[serde(default)]
        severity_text: Option<String>,
        #[serde(default)]
        trace_id: Option<String>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        span_kind: Option<String>,
        #[serde(default)]
        span_status: Option<String>,
        #[serde(default)]
        events: Option<Vec<EventInput>>,
        #[serde(default)]
        status_message: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    struct EventInput {
        name: String,
        attributes: Map<String, Value>,
    }

    fn decode_hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex byte"))
            .collect()
    }

    fn to_any(value: &Value) -> AnyValue {
        let inner = match value {
            Value::Null => None,
            Value::Bool(flag) => Some(any_value::Value::BoolValue(*flag)),
            Value::Number(number) if number.is_f64() => Some(any_value::Value::DoubleValue(
                number.as_f64().expect("double"),
            )),
            Value::Number(number) => Some(any_value::Value::IntValue(number.as_i64().expect("int"))),
            Value::String(text) => Some(any_value::Value::StringValue(text.clone())),
            Value::Array(items) => Some(any_value::Value::ArrayValue(ArrayValue {
                values: items.iter().map(to_any).collect(),
            })),
            Value::Object(map) => match map.get("$bytes") {
                Some(Value::String(hex)) if map.len() == 1 => {
                    Some(any_value::Value::BytesValue(decode_hex(hex)))
                }
                _ => Some(any_value::Value::KvlistValue(KeyValueList {
                    values: to_kvs(map),
                })),
            },
        };
        AnyValue { value: inner }
    }

    fn to_kvs(map: &Map<String, Value>) -> Vec<KeyValue> {
        map.iter()
            .map(|(key, value)| KeyValue {
                key: key.clone(),
                value: Some(to_any(value)),
                ..Default::default()
            })
            .collect()
    }

    fn from_any(value: &AnyValue) -> Value {
        match &value.value {
            None => Value::Null,
            Some(any_value::Value::StringValue(text)) => json!(text),
            Some(any_value::Value::BoolValue(flag)) => json!(flag),
            Some(any_value::Value::IntValue(int)) => json!(int),
            Some(any_value::Value::DoubleValue(double)) => json!(double),
            Some(any_value::Value::ArrayValue(array)) => {
                Value::Array(array.values.iter().map(from_any).collect())
            }
            Some(any_value::Value::KvlistValue(list)) => Value::Object(from_kvs(&list.values)),
            Some(any_value::Value::BytesValue(bytes)) => {
                let mut hex = String::new();
                push_hex(&mut hex, bytes);
                json!({ "$bytes": hex })
            }
            Some(any_value::Value::StringValueStrindex(index)) => json!({ "$strindex": index }),
        }
    }

    fn from_kvs(attributes: &[KeyValue]) -> Map<String, Value> {
        attributes
            .iter()
            .map(|kv| (kv.key.clone(), kv.value.as_ref().map_or(Value::Null, from_any)))
            .collect()
    }

    fn position(names: &[&str], name: Option<&str>) -> i32 {
        name.and_then(|name| names.iter().position(|candidate| *candidate == name))
            .map_or(0, |index| i32::try_from(index).expect("small enum"))
    }

    fn resource_of(input: &Input) -> Option<Resource> {
        Some(Resource {
            attributes: to_kvs(&input.resource),
            ..Default::default()
        })
    }

    fn kept(resource: &[KeyValue], attributes: &[KeyValue]) -> Value {
        json!({
            "dropped": false,
            "resource": from_kvs(resource),
            "attributes": from_kvs(attributes),
        })
    }

    fn run_traces(rules: &CompiledRules, input: &Input) -> Value {
        let span = Span {
            name: input.name.clone().unwrap_or_default(),
            kind: position(&SPAN_KINDS, input.span_kind.as_deref()),
            status: Some(Status {
                code: position(&SPAN_STATUSES, input.span_status.as_deref()),
                message: input.status_message.clone().unwrap_or_default(),
            }),
            trace_id: input.trace_id.as_deref().map(decode_hex).unwrap_or_default(),
            attributes: to_kvs(&input.attributes),
            events: input
                .events
                .iter()
                .flatten()
                .map(|event| span::Event {
                    name: event.name.clone(),
                    attributes: to_kvs(&event.attributes),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        let mut request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: resource_of(input),
                scope_spans: vec![ScopeSpans {
                    scope: Some(InstrumentationScope::default()),
                    spans: vec![span],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };
        apply_traces(rules, &mut request, &mut RuleStats::default());
        let Some(resource_spans) = request.resource_spans.first() else {
            return json!({ "dropped": true });
        };
        let span = &resource_spans.scope_spans[0].spans[0];
        let resource = resource_attributes(resource_spans.resource.as_ref());
        let mut out = kept(resource, &span.attributes);
        if input.events.is_some() {
            out["events"] = span
                .events
                .iter()
                .map(|event| json!({ "name": event.name, "attributes": from_kvs(&event.attributes) }))
                .collect();
        }
        if input.status_message.is_some() {
            out["statusMessage"] = json!(span.status.as_ref().map(|status| status.message.clone()));
        }
        out
    }

    fn run_logs(rules: &CompiledRules, input: &Input) -> Value {
        let record = LogRecord {
            severity_number: input.severity_number.unwrap_or(0),
            severity_text: input.severity_text.clone().unwrap_or_default(),
            body: input.body.as_ref().map(to_any),
            attributes: to_kvs(&input.attributes),
            trace_id: input.trace_id.as_deref().map(decode_hex).unwrap_or_default(),
            ..Default::default()
        };
        let mut request = ExportLogsServiceRequest {
            resource_logs: vec![ResourceLogs {
                resource: resource_of(input),
                scope_logs: vec![ScopeLogs {
                    scope: Some(InstrumentationScope::default()),
                    log_records: vec![record],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };
        apply_logs(rules, &mut request, &mut RuleStats::default());
        let Some(resource_logs) = request.resource_logs.first() else {
            return json!({ "dropped": true });
        };
        let record = &resource_logs.scope_logs[0].log_records[0];
        let resource = resource_attributes(resource_logs.resource.as_ref());
        let mut out = kept(resource, &record.attributes);
        if input.body.is_some() {
            out["body"] = record.body.as_ref().map_or(Value::Null, from_any);
        }
        out
    }

    fn number_point(attributes: Vec<KeyValue>) -> NumberDataPoint {
        NumberDataPoint {
            attributes,
            value: Some(number_data_point::Value::AsInt(1)),
            ..Default::default()
        }
    }

    fn gauge(name: &str, points: Vec<NumberDataPoint>) -> Metric {
        Metric {
            name: name.to_owned(),
            data: Some(metric::Data::Gauge(Gauge { data_points: points })),
            ..Default::default()
        }
    }

    fn metrics_request(resource: Option<Resource>, metrics: Vec<Metric>) -> ExportMetricsServiceRequest {
        ExportMetricsServiceRequest {
            resource_metrics: vec![ResourceMetrics {
                resource,
                scope_metrics: vec![ScopeMetrics {
                    scope: Some(InstrumentationScope::default()),
                    metrics,
                    ..Default::default()
                }],
                ..Default::default()
            }],
        }
    }

    fn run_metrics(rules: &CompiledRules, input: &Input) -> Value {
        let metric = gauge(
            input.name.as_deref().unwrap_or_default(),
            vec![number_point(to_kvs(&input.attributes))],
        );
        let mut request = metrics_request(resource_of(input), vec![metric]);
        apply_metrics(rules, &mut request, &mut RuleStats::default());
        let Some(resource_metrics) = request.resource_metrics.first() else {
            return json!({ "dropped": true });
        };
        let Some(metric::Data::Gauge(data)) = &resource_metrics.scope_metrics[0].metrics[0].data
        else {
            panic!("the gauge changed kind");
        };
        let resource = resource_attributes(resource_metrics.resource.as_ref());
        kept(resource, &data.data_points[0].attributes)
    }

    fn run_case(case: &Case) -> Value {
        let rules = case
            .rules
            .iter()
            .enumerate()
            .map(|(index, rule)| (format!("r{index}"), rule.clone()))
            .collect();
        let (compiled, invalid) = CompiledRules::compile(rules, case.salt.clone());
        assert!(invalid.is_empty(), "{}: invalid rules {invalid:?}", case.name);
        match case.input.signal {
            IngestSignal::Traces => run_traces(&compiled, &case.input),
            IngestSignal::Logs => run_logs(&compiled, &case.input),
            IngestSignal::Metrics => run_metrics(&compiled, &case.input),
        }
    }

    fn run_fixtures(source: &str) {
        let cases: Vec<Case> = serde_json::from_str(source).expect("fixtures parse");
        assert!(!cases.is_empty(), "no fixture cases");
        let failures: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let actual = run_case(case);
                (actual != case.expected).then(|| {
                    format!(
                        "{}\n  expected {}\n  actual   {actual}",
                        case.name, case.expected
                    )
                })
            })
            .collect();
        assert!(
            failures.is_empty(),
            "{} of {} fixture cases failed:\n{}",
            failures.len(),
            cases.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn doubles_format_like_the_ts_engine() {
        let cases = [
            (f64::INFINITY, "inf"),
            (f64::NEG_INFINITY, "-inf"),
            (f64::NAN, "NaN"),
            (-0.0, "-0"),
            (1e21, "1000000000000000000000"),
            (1.5e-7, "0.00000015"),
            (2.0, "2"),
        ];
        for (value, expected) in cases {
            assert_eq!(format_double(value), expected, "formatting {value}");
        }
    }

    #[test]
    fn drop_fixtures_conform() {
        run_fixtures(DROP_FIXTURES);
    }

    #[test]
    fn redact_fixtures_conform() {
        run_fixtures(REDACT_FIXTURES);
    }

    fn spec(value: Value) -> IngestRuleSpec {
        serde_json::from_value(value).expect("rule spec")
    }

    fn string_kv(key: &str, value: &str) -> KeyValue {
        KeyValue {
            key: key.to_owned(),
            value: string_value(value.to_owned()),
            ..Default::default()
        }
    }

    fn named_span(name: &str) -> Span {
        Span {
            name: name.to_owned(),
            trace_id: vec![1; 16],
            attributes: vec![string_kv("k", "v")],
            ..Default::default()
        }
    }

    fn traces_request(resources: Vec<(&str, Vec<Span>)>) -> ExportTraceServiceRequest {
        ExportTraceServiceRequest {
            resource_spans: resources
                .into_iter()
                .map(|(service, spans)| ResourceSpans {
                    resource: Some(Resource {
                        attributes: vec![string_kv("service.name", service)],
                        ..Default::default()
                    }),
                    scope_spans: vec![ScopeSpans {
                        spans,
                        ..Default::default()
                    }],
                    ..Default::default()
                })
                .collect(),
        }
    }

    fn drop_spans_named(name: &str) -> IngestRuleSpec {
        spec(json!({
            "signals": ["traces"],
            "conditions": [{ "field": "name", "op": "eq", "value": name }],
            "action": { "_tag": "drop", "keepPercent": 0 }
        }))
    }

    #[test]
    fn empty_rules_leave_the_request_untouched() {
        let (rules, invalid) = CompiledRules::compile(Vec::new(), "salt".to_owned());
        assert!(rules.is_empty());
        assert!(invalid.is_empty());
        let mut request = traces_request(vec![("api", vec![named_span("a")])]);
        let before = request.clone();
        let mut stats = RuleStats::default();
        apply_traces(&rules, &mut request, &mut stats);
        assert_eq!(request, before);
        assert_eq!(stats, RuleStats::default());
    }

    #[test]
    fn invalid_regexes_are_reported_and_skipped() {
        let bad_pattern = spec(json!({
            "signals": ["logs"],
            "conditions": [],
            "action": { "_tag": "redact", "keys": [], "detectors": [], "patterns": ["(unclosed"],
                "scopes": ["attributes"], "method": "mask" }
        }));
        let bad_condition = spec(json!({
            "signals": ["logs"],
            "conditions": [{ "field": "body", "op": "regex", "value": "[a-" }],
            "action": { "_tag": "drop", "keepPercent": 0 }
        }));
        let rules = vec![
            ("bad-pattern".to_owned(), bad_pattern),
            ("bad-condition".to_owned(), bad_condition),
            ("good".to_owned(), drop_spans_named("x")),
        ];
        let (compiled, invalid) = CompiledRules::compile(rules, String::new());
        assert_eq!(compiled.rule_ids(), ["good".to_owned()]);
        let ids: Vec<&str> = invalid.iter().map(|rule| rule.id.as_str()).collect();
        assert_eq!(ids, ["bad-pattern", "bad-condition"]);
    }

    #[test]
    fn drops_are_counted_on_the_first_dropping_rule() {
        let rules = vec![
            ("first".to_owned(), drop_spans_named("health")),
            ("second".to_owned(), drop_spans_named("health")),
        ];
        let (compiled, _) = CompiledRules::compile(rules, String::new());
        let dropped = named_span("health");
        let dropped_bytes = u64::try_from(dropped.encoded_len()).expect("small span");
        let mut request = traces_request(vec![("api", vec![dropped, named_span("checkout")])]);
        let mut stats = RuleStats::default();
        apply_traces(&compiled, &mut request, &mut stats);

        let names: Vec<&str> = request.resource_spans[0].scope_spans[0]
            .spans
            .iter()
            .map(|span| span.name.as_str())
            .collect();
        assert_eq!(names, ["checkout"]);
        let first = RuleCounters {
            matched: 1,
            dropped: 1,
            dropped_bytes,
            redacted_values: 0,
        };
        assert_eq!(stats.per_rule, [first, RuleCounters { matched: 1, ..RuleCounters::default() }]);
        assert_eq!(stats.total.dropped_bytes, dropped_bytes);
    }

    #[test]
    fn emptied_scopes_and_resources_are_removed() {
        let rules = vec![("health".to_owned(), drop_spans_named("health"))];
        let (compiled, _) = CompiledRules::compile(rules, String::new());
        let mut request = traces_request(vec![
            ("api", vec![named_span("health")]),
            ("web", vec![named_span("render")]),
        ]);
        apply_traces(&compiled, &mut request, &mut RuleStats::default());
        let services: Vec<Option<Value>> = request
            .resource_spans
            .iter()
            .map(|rs| from_kvs(resource_attributes(rs.resource.as_ref())).get("service.name").cloned())
            .collect();
        assert_eq!(services, [Some(json!("web"))]);
    }

    #[test]
    fn metric_drops_ignore_keep_percent_and_remove_emptied_metrics() {
        let rule = spec(json!({
            "signals": ["metrics"],
            "conditions": [{ "field": "name", "op": "prefix", "value": "process." }],
            "action": { "_tag": "drop", "keepPercent": 50 }
        }));
        let (compiled, _) = CompiledRules::compile(vec![("process".to_owned(), rule)], String::new());
        let sum = Metric {
            name: "process.cpu".to_owned(),
            data: Some(metric::Data::Sum(Sum {
                data_points: vec![number_point(Vec::new()), number_point(Vec::new())],
                ..Default::default()
            })),
            ..Default::default()
        };
        let duration = gauge("http.server.duration", vec![number_point(Vec::new())]);
        let mut request = metrics_request(None, vec![sum, duration]);
        let mut stats = RuleStats::default();
        apply_metrics(&compiled, &mut request, &mut stats);

        let names: Vec<&str> = request.resource_metrics[0].scope_metrics[0]
            .metrics
            .iter()
            .map(|metric| metric.name.as_str())
            .collect();
        assert_eq!(names, ["http.server.duration"]);
        assert_eq!(stats.total.dropped, 2);
    }

    #[test]
    fn resource_redaction_waits_until_every_record_was_evaluated() {
        let mask_host = spec(json!({
            "signals": ["logs"],
            "conditions": [],
            "action": { "_tag": "redact", "keys": ["host.name"], "detectors": [], "patterns": [],
                "scopes": ["resource"], "method": "mask" }
        }));
        let mask_k_on_h1 = spec(json!({
            "signals": ["logs"],
            "conditions": [{ "field": "resource_attribute", "key": "host.name", "op": "eq", "value": "h1" }],
            "action": { "_tag": "redact", "keys": ["k"], "detectors": [], "patterns": [],
                "scopes": ["attributes"], "method": "mask" }
        }));
        let rules = vec![("host".to_owned(), mask_host), ("k".to_owned(), mask_k_on_h1)];
        let (compiled, _) = CompiledRules::compile(rules, String::new());
        let record = LogRecord {
            attributes: vec![string_kv("k", "secret")],
            ..Default::default()
        };
        let mut request = ExportLogsServiceRequest {
            resource_logs: vec![ResourceLogs {
                resource: Some(Resource {
                    attributes: vec![string_kv("service.name", "api"), string_kv("host.name", "h1")],
                    ..Default::default()
                }),
                scope_logs: vec![ScopeLogs {
                    log_records: vec![record.clone(), record],
                    ..Default::default()
                }],
                ..Default::default()
            }],
        };
        let mut stats = RuleStats::default();
        apply_logs(&compiled, &mut request, &mut stats);

        let resource_logs = &request.resource_logs[0];
        assert_eq!(
            Value::Object(from_kvs(resource_attributes(resource_logs.resource.as_ref()))),
            json!({ "service.name": "api", "host.name": "[REDACTED]" })
        );
        let records: Vec<Value> = resource_logs.scope_logs[0]
            .log_records
            .iter()
            .map(|record| Value::Object(from_kvs(&record.attributes)))
            .collect();
        assert_eq!(records, [json!({ "k": "[REDACTED]" }), json!({ "k": "[REDACTED]" })]);
        assert_eq!(stats.per_rule[0].redacted_values, 1);
        assert_eq!(stats.per_rule[1].redacted_values, 2);
    }
}
