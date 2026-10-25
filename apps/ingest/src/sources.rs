//! Sources: anything that sends data to Maple, rows in Postgres `sources`. A
//! token source (`maple_src_`) carries a signal allow-list, a fleet-wide rate
//! limit, resource attribute overrides, an optional expiry and a pause window.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use moka::future::Cache;
use serde::Deserialize;
use tracing::warn;

pub(crate) const SOURCE_TOKEN_PREFIX: &str = "maple_src_";

const PUBLIC_ID_PREFIX: &str = "src_";
const PUBLIC_ID_VERSION: u8 = 0x01;
const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const RATE_LIMIT_BUCKETS_MAX: u64 = 100_000;
const RATE_LIMIT_BUCKET_IDLE: Duration = Duration::from_mins(10);

/// The signal families a source token can be scoped to. The wire names match the
/// `allowed_signals` jsonb written by the API.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SourceSignal {
    Traces,
    Logs,
    Metrics,
    /// `/v1/sessionReplays/*` and `/v1/sessionEvents`.
    Sessions,
    /// `/v1/events` (product events).
    Events,
}

impl SourceSignal {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Traces => "traces",
            Self::Logs => "logs",
            Self::Metrics => "metrics",
            Self::Sessions => "sessions",
            Self::Events => "events",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "traces" => Some(Self::Traces),
            "logs" => Some(Self::Logs),
            "metrics" => Some(Self::Metrics),
            "sessions" => Some(Self::Sessions),
            "events" => Some(Self::Events),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OverrideMode {
    /// Overwrite whatever the sender put there.
    Set,
    /// Only fill the attribute in when the sender left it out.
    Default,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResourceAttributeOverride {
    pub(crate) key: String,
    pub(crate) value: String,
    pub(crate) mode: OverrideMode,
}

/// The configuration columns of a token `sources` row, jsonb as text.
#[derive(Clone, Debug, Default)]
pub(crate) struct SourceConfigRow {
    pub(crate) id: String,
    pub(crate) allowed_signals_json: Option<String>,
    pub(crate) rate_limit_rps: Option<i32>,
    pub(crate) resource_attributes_json: String,
    pub(crate) expires_at_ms: Option<i64>,
    pub(crate) paused_at_ms: Option<i64>,
    pub(crate) paused_until_ms: Option<i64>,
}

/// A resolved source's policy, built once per cache fill.
#[derive(Debug)]
pub(crate) struct SourcePolicy {
    pub(crate) id: String,
    pub(crate) public_id: String,
    /// `None` allows every signal; `Some(empty)` allows none.
    allowed_signals: Option<Vec<SourceSignal>>,
    pub(crate) rate_limit_rps: Option<u32>,
    pub(crate) resource_attributes: Vec<ResourceAttributeOverride>,
    pub(crate) expires_at_ms: Option<i64>,
    paused_at_ms: Option<i64>,
    /// `None` while paused means paused until resumed.
    paused_until_ms: Option<i64>,
}

#[derive(Deserialize)]
struct RawOverride {
    key: String,
    value: String,
    mode: String,
}

impl SourcePolicy {
    pub(crate) fn from_row(row: &SourceConfigRow) -> Self {
        let public_id = public_source_id(&row.id).unwrap_or_else(|| {
            warn!(key_id = %row.id, "Source id is not a UUID; using it verbatim");
            row.id.clone()
        });
        Self {
            id: row.id.clone(),
            public_id,
            allowed_signals: parse_allowed_signals(&row.id, row.allowed_signals_json.as_deref()),
            rate_limit_rps: row
                .rate_limit_rps
                .and_then(|rps| u32::try_from(rps).ok())
                .filter(|rps| *rps > 0),
            resource_attributes: parse_resource_attributes(&row.id, &row.resource_attributes_json),
            expires_at_ms: row.expires_at_ms,
            paused_at_ms: row.paused_at_ms,
            paused_until_ms: row.paused_until_ms,
        }
    }

    pub(crate) fn allows(&self, signal: SourceSignal) -> bool {
        self.allowed_signals
            .as_ref()
            .is_none_or(|allowed| allowed.contains(&signal))
    }

    pub(crate) fn is_expired(&self, now_ms: i64) -> bool {
        self.expires_at_ms
            .is_some_and(|expires_at| now_ms >= expires_at)
    }

    /// A paused key is accepted but its data is dropped. Matches the API's status.
    pub(crate) fn is_paused(&self, now_ms: i64) -> bool {
        PauseWindow {
            paused_at_ms: self.paused_at_ms,
            paused_until_ms: self.paused_until_ms,
        }
        .is_paused(now_ms)
    }
}

/// A source's `paused_at` / `paused_until`, kept as read so a cached copy is
/// judged against the clock of each request.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PauseWindow {
    pub(crate) paused_at_ms: Option<i64>,
    /// `None` while paused means paused until resumed.
    pub(crate) paused_until_ms: Option<i64>,
}

impl PauseWindow {
    pub(crate) fn is_paused(self, now_ms: i64) -> bool {
        self.paused_at_ms.is_some()
            && self
                .paused_until_ms
                .is_none_or(|paused_until| now_ms < paused_until)
    }
}

/// Fails closed: an allow-list that does not parse allows nothing.
fn parse_allowed_signals(key_id: &str, raw: Option<&str>) -> Option<Vec<SourceSignal>> {
    let raw = raw?;
    match serde_json::from_str::<Option<Vec<String>>>(raw) {
        Ok(parsed) => parsed.map(|names| {
            names
                .iter()
                .filter_map(|name| SourceSignal::parse(name))
                .collect()
        }),
        Err(error) => {
            warn!(key_id, error = %error, "Malformed allowed_signals on source; denying all signals");
            Some(Vec::new())
        }
    }
}

/// Fails open: overrides that do not parse are skipped and the key still works.
fn parse_resource_attributes(key_id: &str, raw: &str) -> Vec<ResourceAttributeOverride> {
    let parsed = match serde_json::from_str::<Option<Vec<RawOverride>>>(raw) {
        Ok(parsed) => parsed.unwrap_or_default(),
        Err(error) => {
            warn!(key_id, error = %error, "Malformed resource_attributes on source; ignoring overrides");
            return Vec::new();
        }
    };
    parsed
        .into_iter()
        .filter_map(|raw| {
            let mode = match raw.mode.as_str() {
                "set" => OverrideMode::Set,
                "default" => OverrideMode::Default,
                other => {
                    warn!(
                        key_id,
                        mode = other,
                        "Skipping resource attribute override with unknown mode"
                    );
                    return None;
                }
            };
            (!is_protected_attribute(&raw.key)).then_some(ResourceAttributeOverride {
                key: raw.key,
                value: raw.value,
                mode,
            })
        })
        .collect()
}

/// Keys the gateway owns; an override must never write them.
pub(crate) fn is_protected_attribute(key: &str) -> bool {
    key.is_empty() || key == "org_id" || key.starts_with("maple_")
}

/// The resource attribute naming the source a batch came from.
pub(crate) const SOURCE_ID_ATTRIBUTE: &str = "maple_source_id";

/// A source stamped on data without a token policy: an org's default source or
/// an integration's source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SourceRef {
    /// The `sources.id` uuid.
    pub(crate) id: String,
    pub(crate) public_id: String,
}

impl SourceRef {
    /// `None` when the id is not a uuid, so nothing unverifiable is stamped.
    pub(crate) fn from_id(id: String) -> Option<Self> {
        let public_id = public_source_id(&id)?;
        Some(Self { id, public_id })
    }
}

/// The `sources.id` uuid behind a `src_` public id; `None` when it is not one.
/// 17 bytes encode to at most 24 base58 characters, so no valid id is longer than this.
pub(crate) const MAX_PUBLIC_ID_LEN: usize = PUBLIC_ID_PREFIX.len() + 24;

pub(crate) fn source_uuid_from_public_id(public_id: &str) -> Option<String> {
    // `base58_decode` is quadratic, so oversized sender input must never reach it.
    if public_id.len() > MAX_PUBLIC_ID_LEN {
        return None;
    }
    let encoded = public_id.strip_prefix(PUBLIC_ID_PREFIX)?;
    let bytes = base58_decode(encoded)?;
    let (&version, uuid) = bytes.split_first()?;
    if version != PUBLIC_ID_VERSION || uuid.len() != 16 {
        return None;
    }
    let parsed = uuid::Uuid::from_slice(uuid).ok()?;
    // Round-trips, so a non-canonical spelling of an id cannot pass as it.
    let uuid = parsed.hyphenated().to_string();
    (public_source_id(&uuid).as_deref() == Some(public_id)).then_some(uuid)
}

/// `src_` + base58 of `[0x01] ++ uuid bytes`. Must match the API's encoding.
pub(crate) fn public_source_id(uuid: &str) -> Option<String> {
    let parsed = uuid::Uuid::parse_str(uuid).ok()?;
    let mut bytes = [0u8; 17];
    bytes[0] = PUBLIC_ID_VERSION;
    bytes[1..].copy_from_slice(parsed.as_bytes());
    Some(format!("{PUBLIC_ID_PREFIX}{}", base58_encode(&bytes)))
}

fn base58_encode(bytes: &[u8]) -> String {
    let leading_zeros = bytes.iter().take_while(|byte| **byte == 0).count();
    // Little-endian base-58 digits.
    let mut digits: Vec<usize> = Vec::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        let mut carry = usize::from(byte);
        for digit in &mut digits {
            carry += *digit << 8;
            *digit = carry % 58;
            carry /= 58;
        }
        while carry > 0 {
            digits.push(carry % 58);
            carry /= 58;
        }
    }
    let mut encoded = String::with_capacity(leading_zeros + digits.len());
    encoded.extend(std::iter::repeat_n('1', leading_zeros));
    encoded.extend(
        digits
            .iter()
            .rev()
            .map(|digit| char::from(BASE58_ALPHABET[*digit])),
    );
    encoded
}

fn base58_decode(encoded: &str) -> Option<Vec<u8>> {
    let leading_ones = encoded.bytes().take_while(|byte| *byte == b'1').count();
    // Little-endian base-256 digits.
    let mut bytes: Vec<u8> = Vec::with_capacity(encoded.len());
    for character in encoded.bytes() {
        let mut carry = BASE58_ALPHABET
            .iter()
            .position(|digit| *digit == character)?;
        for byte in &mut bytes {
            carry += usize::from(*byte) * 58;
            *byte = u8::try_from(carry & 0xff).ok()?;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push(u8::try_from(carry & 0xff).ok()?);
            carry >>= 8;
        }
    }
    let mut decoded = vec![0u8; leading_ones];
    decoded.extend(bytes.iter().rev());
    Some(decoded)
}

/// This instance's share of a fleet-wide requests/second limit.
pub(crate) fn per_instance_limit(rps: u32, fleet_size: u32) -> u32 {
    rps.div_ceil(fleet_size.max(1)).max(1)
}

#[derive(Debug)]
struct TokenBucket {
    limit: u32,
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(limit: u32, now: Instant) -> Self {
        Self {
            limit,
            tokens: f64::from(limit),
            last_refill: now,
        }
    }

    fn try_take(&mut self, limit: u32, now: Instant) -> bool {
        // A limit edited in the API reaches the bucket on the next request.
        if limit != self.limit {
            self.limit = limit;
            self.tokens = self.tokens.min(f64::from(limit));
        }
        let elapsed = now
            .saturating_duration_since(self.last_refill)
            .as_secs_f64();
        self.tokens = elapsed
            .mul_add(f64::from(limit), self.tokens)
            .min(f64::from(limit));
        self.last_refill = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Per-key token buckets with a one-second burst. Each instance enforces
/// `ceil(rps / fleet_size)`, so the fleet as a whole admits about `rps`.
#[derive(Clone, Debug)]
pub(crate) struct SourceRateLimiter {
    fleet_size: u32,
    buckets: Cache<String, Arc<Mutex<TokenBucket>>>,
}

impl SourceRateLimiter {
    pub(crate) fn new(fleet_size: u32) -> Self {
        Self {
            fleet_size: fleet_size.max(1),
            buckets: Cache::builder()
                .max_capacity(RATE_LIMIT_BUCKETS_MAX)
                .time_to_idle(RATE_LIMIT_BUCKET_IDLE)
                .build(),
        }
    }

    pub(crate) async fn try_acquire(&self, key_id: &str, rps: u32) -> bool {
        self.try_acquire_at(key_id, rps, Instant::now()).await
    }

    pub(crate) async fn try_acquire_at(&self, key_id: &str, rps: u32, now: Instant) -> bool {
        let limit = per_instance_limit(rps, self.fleet_size);
        let bucket = self
            .buckets
            .get_with_by_ref(key_id, async {
                Arc::new(Mutex::new(TokenBucket::new(limit, now)))
            })
            .await;
        let mut bucket = bucket.lock().unwrap_or_else(PoisonError::into_inner);
        bucket.try_take(limit, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(allowed: Option<&str>, attributes: &str) -> SourceConfigRow {
        SourceConfigRow {
            id: "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b".to_owned(),
            allowed_signals_json: allowed.map(str::to_owned),
            rate_limit_rps: None,
            resource_attributes_json: attributes.to_owned(),
            expires_at_ms: None,
            paused_at_ms: None,
            paused_until_ms: None,
        }
    }

    #[test]
    fn public_id_matches_the_api_encoding() {
        assert_eq!(
            public_source_id("0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b").as_deref(),
            Some("src_aXunrkWtzvXSkw9Z2smcft")
        );
        assert_eq!(public_source_id("not-a-uuid"), None);
    }

    #[test]
    fn public_id_decodes_back_to_its_uuid_and_rejects_anything_else() {
        let uuid = "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
        assert_eq!(
            source_uuid_from_public_id("src_aXunrkWtzvXSkw9Z2smcft").as_deref(),
            Some(uuid)
        );
        for bad in [
            "",
            "src_",
            "aXunrkWtzvXSkw9Z2smcft",
            "ingk_aXunrkWtzvXSkw9Z2smcft",
            "src_aXunrkWtzvXSkw9Z2smcf0",
            "src_aXunrkWtzvXSkw9Z2smc",
            "src_1aXunrkWtzvXSkw9Z2smcft",
        ] {
            assert_eq!(
                source_uuid_from_public_id(bad),
                None,
                "{bad} must not decode"
            );
        }
        assert_eq!(
            base58_decode("StV1DL6CwTryKyV").as_deref(),
            Some(&b"hello world"[..])
        );
        assert_eq!(base58_decode("112").as_deref(), Some(&[0, 0, 1][..]));
    }

    #[test]
    fn oversized_public_ids_are_rejected_before_decoding() {
        let long = format!("{PUBLIC_ID_PREFIX}{}", "z".repeat(10_000));
        assert_eq!(source_uuid_from_public_id(&long), None);
        let valid = public_source_id("0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b").unwrap();
        assert!(valid.len() <= MAX_PUBLIC_ID_LEN);
        assert!(source_uuid_from_public_id(&valid).is_some());
    }

    #[test]
    fn base58_keeps_leading_zero_bytes() {
        assert_eq!(base58_encode(&[0, 0, 1]), "112");
        assert_eq!(base58_encode(b"hello world"), "StV1DL6CwTryKyV");
        assert_eq!(base58_encode(&[]), "");
    }

    #[test]
    fn allowed_signals_default_to_all_and_fail_closed() {
        let all = SourcePolicy::from_row(&row(None, "[]"));
        assert!(all.allows(SourceSignal::Logs) && all.allows(SourceSignal::Events));

        let json_null = SourcePolicy::from_row(&row(Some("null"), "[]"));
        assert!(json_null.allows(SourceSignal::Metrics));

        let scoped = SourcePolicy::from_row(&row(Some(r#"["traces","sessions"]"#), "[]"));
        assert!(scoped.allows(SourceSignal::Traces));
        assert!(scoped.allows(SourceSignal::Sessions));
        assert!(!scoped.allows(SourceSignal::Logs));
        assert!(!scoped.allows(SourceSignal::Events));

        let malformed = SourcePolicy::from_row(&row(Some(r#"{"traces":true}"#), "[]"));
        for signal in [
            SourceSignal::Traces,
            SourceSignal::Logs,
            SourceSignal::Metrics,
            SourceSignal::Sessions,
            SourceSignal::Events,
        ] {
            assert!(
                !malformed.allows(signal),
                "{} must be denied",
                signal.as_str()
            );
        }
    }

    #[test]
    fn resource_attributes_fail_open_and_drop_protected_keys() {
        let policy = SourcePolicy::from_row(&row(
            None,
            r#"[{"key":"service.name","value":"checkout","mode":"set"},
                {"key":"deployment.environment","value":"prod","mode":"default"},
                {"key":"maple_org_id","value":"org_evil","mode":"set"},
                {"key":"org_id","value":"org_evil","mode":"set"},
                {"key":"team","value":"x","mode":"merge"}]"#,
        ));
        assert_eq!(
            policy.resource_attributes,
            vec![
                ResourceAttributeOverride {
                    key: "service.name".to_owned(),
                    value: "checkout".to_owned(),
                    mode: OverrideMode::Set,
                },
                ResourceAttributeOverride {
                    key: "deployment.environment".to_owned(),
                    value: "prod".to_owned(),
                    mode: OverrideMode::Default,
                },
            ]
        );

        let malformed = SourcePolicy::from_row(&row(Some(r#"["logs"]"#), "{oops"));
        assert!(malformed.resource_attributes.is_empty());
        assert!(malformed.allows(SourceSignal::Logs));
    }

    #[test]
    fn expiry_is_inclusive_of_the_deadline() {
        let mut config = row(None, "[]");
        config.expires_at_ms = Some(1_000);
        let policy = SourcePolicy::from_row(&config);
        assert!(!policy.is_expired(999));
        assert!(policy.is_expired(1_000));
        assert!(!SourcePolicy::from_row(&row(None, "[]")).is_expired(i64::MAX));
    }

    #[test]
    fn a_timed_pause_ends_at_its_deadline_and_an_open_one_never_does() {
        let mut config = row(None, "[]");
        assert!(!SourcePolicy::from_row(&config).is_paused(0));
        config.paused_at_ms = Some(100);
        config.paused_until_ms = Some(1_000);
        let timed = SourcePolicy::from_row(&config);
        assert!(timed.is_paused(999));
        assert!(!timed.is_paused(1_000));
        config.paused_until_ms = None;
        assert!(SourcePolicy::from_row(&config).is_paused(i64::MAX));
    }

    #[test]
    fn a_pause_window_without_a_start_is_never_paused() {
        let ended = PauseWindow {
            paused_at_ms: Some(100),
            paused_until_ms: Some(1_000),
        };
        assert!(ended.is_paused(999));
        assert!(!ended.is_paused(1_000));
        let unstarted = PauseWindow {
            paused_at_ms: None,
            paused_until_ms: Some(i64::MAX),
        };
        assert!(!unstarted.is_paused(0));
    }

    #[test]
    fn non_positive_rate_limits_mean_unlimited() {
        let mut config = row(None, "[]");
        config.rate_limit_rps = Some(0);
        assert_eq!(SourcePolicy::from_row(&config).rate_limit_rps, None);
        config.rate_limit_rps = Some(-5);
        assert_eq!(SourcePolicy::from_row(&config).rate_limit_rps, None);
        config.rate_limit_rps = Some(25);
        assert_eq!(SourcePolicy::from_row(&config).rate_limit_rps, Some(25));
    }

    #[test]
    fn fleet_split_rounds_up_and_never_reaches_zero() {
        assert_eq!(per_instance_limit(100, 1), 100);
        assert_eq!(per_instance_limit(100, 3), 34);
        assert_eq!(per_instance_limit(10, 4), 3);
        assert_eq!(per_instance_limit(1, 8), 1);
        assert_eq!(per_instance_limit(5, 0), 5);
    }

    #[tokio::test]
    async fn bucket_admits_its_burst_then_refills_over_time() {
        let limiter = SourceRateLimiter::new(1);
        let start = Instant::now();
        for _ in 0..5 {
            assert!(limiter.try_acquire_at("key_a", 5, start).await);
        }
        assert!(!limiter.try_acquire_at("key_a", 5, start).await);
        // Another key has its own bucket.
        assert!(limiter.try_acquire_at("key_b", 5, start).await);

        // 200ms at 5 rps refills exactly one token.
        let later = start + Duration::from_millis(200);
        assert!(limiter.try_acquire_at("key_a", 5, later).await);
        assert!(!limiter.try_acquire_at("key_a", 5, later).await);

        // A full second refills the burst but never beyond it.
        let much_later = later + Duration::from_secs(10);
        for _ in 0..5 {
            assert!(limiter.try_acquire_at("key_a", 5, much_later).await);
        }
        assert!(!limiter.try_acquire_at("key_a", 5, much_later).await);
    }

    #[tokio::test]
    async fn bucket_picks_up_a_changed_limit_and_the_fleet_share() {
        let limiter = SourceRateLimiter::new(2);
        let start = Instant::now();
        // 10 rps across 2 instances is 5 here.
        for _ in 0..5 {
            assert!(limiter.try_acquire_at("key", 10, start).await);
        }
        assert!(!limiter.try_acquire_at("key", 10, start).await);

        // Raised to 40 rps (20 here): refills at the new rate, capped at 20.
        let later = start + Duration::from_secs(1);
        for _ in 0..20 {
            assert!(limiter.try_acquire_at("key", 40, later).await);
        }
        assert!(!limiter.try_acquire_at("key", 40, later).await);
    }
}
