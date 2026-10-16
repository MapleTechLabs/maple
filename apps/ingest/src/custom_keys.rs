//! Custom ingest keys (`maple_ik_`): named per-org keys with a signal
//! allow-list, a fleet-wide request rate limit, resource attribute overrides and
//! an optional expiry. Rows live in Postgres `org_ingest_custom_keys`.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use moka::future::Cache;
use serde::Deserialize;
use tracing::warn;

pub(crate) const CUSTOM_KEY_PREFIX: &str = "maple_ik_";

const PUBLIC_ID_PREFIX: &str = "ingk_";
const PUBLIC_ID_VERSION: u8 = 0x01;
const BASE58_ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const RATE_LIMIT_BUCKETS_MAX: u64 = 100_000;
const RATE_LIMIT_BUCKET_IDLE: Duration = Duration::from_mins(10);

/// The signal families a custom key can be scoped to. The wire names match the
/// `allowed_signals` jsonb written by the API.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeySignal {
    Traces,
    Logs,
    Metrics,
    /// `/v1/sessionReplays/*` and `/v1/sessionEvents`.
    Sessions,
    /// `/v1/events` (product events).
    Events,
}

impl KeySignal {
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

/// The configuration columns of an `org_ingest_custom_keys` row, jsonb as text.
#[derive(Clone, Debug, Default)]
pub(crate) struct CustomKeyConfigRow {
    pub(crate) id: String,
    pub(crate) allowed_signals_json: Option<String>,
    pub(crate) rate_limit_rps: Option<i32>,
    pub(crate) resource_attributes_json: String,
    pub(crate) expires_at_ms: Option<i64>,
}

/// A resolved custom key's policy, built once per cache fill.
#[derive(Debug)]
pub(crate) struct CustomKeyPolicy {
    pub(crate) id: String,
    pub(crate) public_id: String,
    /// `None` allows every signal; `Some(empty)` allows none.
    allowed_signals: Option<Vec<KeySignal>>,
    pub(crate) rate_limit_rps: Option<u32>,
    pub(crate) resource_attributes: Vec<ResourceAttributeOverride>,
    pub(crate) expires_at_ms: Option<i64>,
}

#[derive(Deserialize)]
struct RawOverride {
    key: String,
    value: String,
    mode: String,
}

impl CustomKeyPolicy {
    pub(crate) fn from_row(row: &CustomKeyConfigRow) -> Self {
        let public_id = public_key_id(&row.id).unwrap_or_else(|| {
            warn!(key_id = %row.id, "Custom ingest key id is not a UUID; using it verbatim");
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
        }
    }

    pub(crate) fn allows(&self, signal: KeySignal) -> bool {
        self.allowed_signals
            .as_ref()
            .is_none_or(|allowed| allowed.contains(&signal))
    }

    pub(crate) fn is_expired(&self, now_ms: i64) -> bool {
        self.expires_at_ms
            .is_some_and(|expires_at| now_ms >= expires_at)
    }
}

/// Fails closed: an allow-list that does not parse allows nothing.
fn parse_allowed_signals(key_id: &str, raw: Option<&str>) -> Option<Vec<KeySignal>> {
    let raw = raw?;
    match serde_json::from_str::<Option<Vec<String>>>(raw) {
        Ok(parsed) => parsed.map(|names| {
            names
                .iter()
                .filter_map(|name| KeySignal::parse(name))
                .collect()
        }),
        Err(error) => {
            warn!(key_id, error = %error, "Malformed allowed_signals on custom ingest key; denying all signals");
            Some(Vec::new())
        }
    }
}

/// Fails open: overrides that do not parse are skipped and the key still works.
fn parse_resource_attributes(key_id: &str, raw: &str) -> Vec<ResourceAttributeOverride> {
    let parsed = match serde_json::from_str::<Option<Vec<RawOverride>>>(raw) {
        Ok(parsed) => parsed.unwrap_or_default(),
        Err(error) => {
            warn!(key_id, error = %error, "Malformed resource_attributes on custom ingest key; ignoring overrides");
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

/// `ingk_` + base58 of `[0x01] ++ uuid bytes`. Must match the API's encoding.
pub(crate) fn public_key_id(uuid: &str) -> Option<String> {
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
pub(crate) struct KeyRateLimiter {
    fleet_size: u32,
    buckets: Cache<String, Arc<Mutex<TokenBucket>>>,
}

impl KeyRateLimiter {
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

    fn row(allowed: Option<&str>, attributes: &str) -> CustomKeyConfigRow {
        CustomKeyConfigRow {
            id: "0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b".to_owned(),
            allowed_signals_json: allowed.map(str::to_owned),
            rate_limit_rps: None,
            resource_attributes_json: attributes.to_owned(),
            expires_at_ms: None,
        }
    }

    #[test]
    fn public_id_matches_the_api_encoding() {
        assert_eq!(
            public_key_id("0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b").as_deref(),
            Some("ingk_aXunrkWtzvXSkw9Z2smcft")
        );
        assert_eq!(public_key_id("not-a-uuid"), None);
    }

    #[test]
    fn base58_keeps_leading_zero_bytes() {
        assert_eq!(base58_encode(&[0, 0, 1]), "112");
        assert_eq!(base58_encode(b"hello world"), "StV1DL6CwTryKyV");
        assert_eq!(base58_encode(&[]), "");
    }

    #[test]
    fn allowed_signals_default_to_all_and_fail_closed() {
        let all = CustomKeyPolicy::from_row(&row(None, "[]"));
        assert!(all.allows(KeySignal::Logs) && all.allows(KeySignal::Events));

        let json_null = CustomKeyPolicy::from_row(&row(Some("null"), "[]"));
        assert!(json_null.allows(KeySignal::Metrics));

        let scoped = CustomKeyPolicy::from_row(&row(Some(r#"["traces","sessions"]"#), "[]"));
        assert!(scoped.allows(KeySignal::Traces));
        assert!(scoped.allows(KeySignal::Sessions));
        assert!(!scoped.allows(KeySignal::Logs));
        assert!(!scoped.allows(KeySignal::Events));

        let malformed = CustomKeyPolicy::from_row(&row(Some(r#"{"traces":true}"#), "[]"));
        for signal in [
            KeySignal::Traces,
            KeySignal::Logs,
            KeySignal::Metrics,
            KeySignal::Sessions,
            KeySignal::Events,
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
        let policy = CustomKeyPolicy::from_row(&row(
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

        let malformed = CustomKeyPolicy::from_row(&row(Some(r#"["logs"]"#), "{oops"));
        assert!(malformed.resource_attributes.is_empty());
        assert!(malformed.allows(KeySignal::Logs));
    }

    #[test]
    fn expiry_is_inclusive_of_the_deadline() {
        let mut config = row(None, "[]");
        config.expires_at_ms = Some(1_000);
        let policy = CustomKeyPolicy::from_row(&config);
        assert!(!policy.is_expired(999));
        assert!(policy.is_expired(1_000));
        assert!(!CustomKeyPolicy::from_row(&row(None, "[]")).is_expired(i64::MAX));
    }

    #[test]
    fn non_positive_rate_limits_mean_unlimited() {
        let mut config = row(None, "[]");
        config.rate_limit_rps = Some(0);
        assert_eq!(CustomKeyPolicy::from_row(&config).rate_limit_rps, None);
        config.rate_limit_rps = Some(-5);
        assert_eq!(CustomKeyPolicy::from_row(&config).rate_limit_rps, None);
        config.rate_limit_rps = Some(25);
        assert_eq!(CustomKeyPolicy::from_row(&config).rate_limit_rps, Some(25));
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
        let limiter = KeyRateLimiter::new(1);
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
        let limiter = KeyRateLimiter::new(2);
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
