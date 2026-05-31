use std::collections::HashMap;
use std::time::Duration;

use maple_ingest::metrics;
use moka::future::Cache;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{error, info, warn};
use uuid::Uuid;

pub struct UsageEvent {
    pub org_id: String,
    pub feature_id: &'static str,
    /// Quantity to bill for this event. Unit depends on `feature_id`: GB for
    /// `logs`/`traces`/`metrics`, a raw count for `browser_sessions`.
    pub value: f64,
}

#[derive(Clone)]
pub struct AutumnTracker {
    tx: mpsc::UnboundedSender<UsageEvent>,
}

#[derive(Serialize)]
struct TrackRequest<'a> {
    customer_id: &'a str,
    feature_id: &'a str,
    value: f64,
    idempotency_key: String,
}

impl AutumnTracker {
    pub fn spawn(secret_key: String, api_url: &str, flush_interval_secs: u64) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let api_url = api_url.trim_end_matches('/').to_string();
        let flush_interval = Duration::from_secs(flush_interval_secs);

        tokio::spawn(flush_loop(rx, secret_key, api_url, flush_interval));

        info!(
            flush_interval_secs,
            "Autumn usage tracker started"
        );

        Self { tx }
    }

    pub fn track(&self, org_id: &str, feature_id: &'static str, value: f64) {
        let _ = self.tx.send(UsageEvent {
            org_id: org_id.to_string(),
            feature_id,
            value,
        });
    }
}

type AccumulatorKey = (String, &'static str); // (org_id, feature_id)

async fn flush_loop(
    mut rx: mpsc::UnboundedReceiver<UsageEvent>,
    secret_key: String,
    api_url: String,
    flush_interval: Duration,
) {
    let client = Client::new();
    let mut accumulator: HashMap<AccumulatorKey, f64> = HashMap::new();
    let mut consecutive_failures: u64 = 0;
    let critical_threshold: u64 = (300 / flush_interval.as_secs().max(1)).max(1);

    let mut interval = tokio::time::interval(flush_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = interval.tick() => {
                if accumulator.is_empty() {
                    continue;
                }

                let flush_start = Instant::now();
                let mut all_ok = true;

                // Collect entries to flush
                let entries: Vec<(AccumulatorKey, f64)> = accumulator
                    .iter()
                    .map(|(k, v)| (k.clone(), *v))
                    .collect();

                let mut flushed_keys: Vec<AccumulatorKey> = Vec::new();

                for ((org_id, feature_id), value) in &entries {
                    let body = TrackRequest {
                        customer_id: org_id,
                        feature_id,
                        value: *value,
                        idempotency_key: Uuid::new_v4().to_string(),
                    };

                    let result: Result<reqwest::Response, reqwest::Error> = client
                        .post(format!("{}/v1/track", api_url))
                        .header("Authorization", format!("Bearer {}", secret_key))
                        .json(&body)
                        .send()
                        .await;

                    match result {
                        Ok(resp) if resp.status().is_success() => {
                            flushed_keys.push((org_id.clone(), feature_id));
                        }
                        Ok(resp) => {
                            let status = resp.status();
                            let body_text = resp.text().await.unwrap_or_default();
                            warn!(
                                org_id,
                                feature_id,
                                status = %status,
                                body = %body_text,
                                "Autumn track request failed"
                            );
                            all_ok = false;
                        }
                        Err(err) => {
                            warn!(
                                org_id,
                                feature_id,
                                error = %err,
                                "Autumn track request failed"
                            );
                            all_ok = false;
                        }
                    }
                }

                // Remove successfully flushed entries
                for key in &flushed_keys {
                    accumulator.remove(key);
                }

                let flush_duration = flush_start.elapsed();

                if all_ok {
                    consecutive_failures = 0;
                    metrics::autumn_flush("ok", flush_duration.as_secs_f64());
                } else {
                    consecutive_failures += 1;
                    metrics::autumn_flush("error", flush_duration.as_secs_f64());

                    if consecutive_failures >= critical_threshold {
                        let total_pending_gb: f64 = accumulator.values().sum();
                        error!(
                            consecutive_failures,
                            pending_entries = accumulator.len(),
                            total_pending_gb,
                            "CRITICAL: Autumn tracking has failed for ~5 minutes. Usage data is accumulating in memory."
                        );
                    }
                }

                // Update pending gauge. Note: this now sums mixed units across
                // features (GB for logs/traces/metrics, counts for browser_sessions);
                // the metric name is kept as-is to avoid breaking existing dashboards.
                let total_pending: f64 = accumulator.values().sum();
                metrics::autumn_pending_gb(total_pending);
            }

            event = rx.recv() => {
                match event {
                    Some(event) => {
                        *accumulator
                            .entry((event.org_id, event.feature_id))
                            .or_insert(0.0) += event.value;
                    }
                    None => {
                        // Channel closed, do a final flush attempt
                        if !accumulator.is_empty() {
                            info!(
                                pending_entries = accumulator.len(),
                                "Autumn tracker shutting down, attempting final flush"
                            );
                            flush_all(&client, &secret_key, &api_url, &mut accumulator).await;
                        }
                        break;
                    }
                }
            }
        }
    }
}

async fn flush_all(
    client: &Client,
    secret_key: &str,
    api_url: &str,
    accumulator: &mut HashMap<AccumulatorKey, f64>,
) {
    let entries: Vec<(AccumulatorKey, f64)> = accumulator
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();

    for ((org_id, feature_id), value) in &entries {
        let body = TrackRequest {
            customer_id: org_id,
            feature_id,
            value: *value,
            idempotency_key: Uuid::new_v4().to_string(),
        };

        let result: Result<reqwest::Response, reqwest::Error> = client
            .post(format!("{}/v1/track", api_url))
            .header("Authorization", format!("Bearer {}", secret_key))
            .json(&body)
            .send()
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => {
                accumulator.remove(&(org_id.clone(), feature_id));
            }
            Ok(resp) => {
                warn!(
                    org_id,
                    feature_id,
                    status = %resp.status(),
                    "Final flush failed for entry"
                );
            }
            Err(err) => {
                warn!(
                    org_id,
                    feature_id,
                    error = %err,
                    "Final flush failed for entry"
                );
            }
        }
    }
}

/// Synchronous, cached entitlement check against Autumn's `POST /v1/check`.
///
/// Unlike [`AutumnTracker`] (fire-and-forget usage metering), this sits in the
/// ingest hot path and gates a request *before* it is accepted. It is only
/// constructed when `AUTUMN_ENFORCE_LIMITS=true` and `AUTUMN_SECRET_KEY` is set,
/// so local dev / self-hosted deployments are unaffected.
#[derive(Clone)]
pub struct AutumnEntitlements {
    client: Client,
    secret_key: String,
    api_url: String,
    // Keyed by `"{org_id}:{feature_id}"`. Holds both confirmed decisions and
    // fail-open allows; a single TTL keeps it simple and mirrors the other moka
    // resolver caches in the gateway.
    cache: Cache<String, bool>,
}

#[derive(Serialize)]
struct CheckRequest<'a> {
    customer_id: &'a str,
    feature_id: &'a str,
}

// Autumn's `/v1/check` response (snake_case on the wire). We only model the
// fields the gating decision needs and `#[serde(default)]` everything, so any
// added/renamed field is ignored rather than failing the parse (which would fail
// us open). `balance` is the `Balance` object, or null when the customer has no
// balance for the feature.
#[derive(Deserialize)]
struct CheckResponse {
    #[serde(default)]
    allowed: bool,
    #[serde(default)]
    balance: Option<FeatureBalance>,
}

#[derive(Deserialize)]
struct FeatureBalance {
    #[serde(default)]
    unlimited: bool,
    #[serde(default, alias = "overageAllowed")]
    overage_allowed: bool,
    /// Remaining balance available for use.
    #[serde(default)]
    remaining: Option<f64>,
}

impl AutumnEntitlements {
    pub fn new(client: Client, secret_key: String, api_url: &str, cache_ttl_secs: u64) -> Self {
        let api_url = api_url.trim_end_matches('/').to_string();
        let cache = Cache::builder()
            .time_to_live(Duration::from_secs(cache_ttl_secs.max(1)))
            .max_capacity(10_000)
            .build();

        info!(cache_ttl_secs, "Autumn entitlement enforcement enabled");

        Self {
            client,
            secret_key,
            api_url,
            cache,
        }
    }

    /// Returns whether `org_id` may ingest the given `feature_id`
    /// (`"logs" | "traces" | "metrics"`). Fails open (`true`) on any
    /// transport/decode error so a billing-provider outage never drops
    /// customer data.
    pub async fn is_allowed(&self, org_id: &str, feature_id: &str) -> bool {
        let cache_key = format!("{org_id}:{feature_id}");
        if let Some(allowed) = self.cache.get(&cache_key).await {
            return allowed;
        }

        let allowed = self.fetch_allowed(org_id, feature_id).await;
        self.cache.insert(cache_key, allowed).await;
        allowed
    }

    async fn fetch_allowed(&self, org_id: &str, feature_id: &str) -> bool {
        let body = CheckRequest {
            customer_id: org_id,
            feature_id,
        };

        let result = self
            .client
            .post(format!("{}/v1/check", self.api_url))
            .header("Authorization", format!("Bearer {}", self.secret_key))
            .timeout(Duration::from_secs(5))
            .json(&body)
            .send()
            .await;

        let response = match result {
            Ok(resp) if resp.status().is_success() => resp,
            Ok(resp) => {
                warn!(
                    org_id,
                    feature_id,
                    status = %resp.status(),
                    "Autumn check returned non-success; failing open"
                );
                return true;
            }
            Err(err) => {
                warn!(
                    org_id,
                    feature_id,
                    error = %err,
                    "Autumn check request failed; failing open"
                );
                return true;
            }
        };

        match response.json::<CheckResponse>().await {
            Ok(check) => decide_allowed(&check),
            Err(err) => {
                warn!(
                    org_id,
                    feature_id,
                    error = %err,
                    "Failed to decode Autumn check response; failing open"
                );
                true
            }
        }
    }
}

/// Block only when the org genuinely has no headroom for the feature:
/// - no balance object: defer to Autumn's own `allowed` flag. An org with no
///   subscription gets `allowed:false` + `balance:null`, so this blocks.
/// - unlimited or overage-allowed (usage-based `startup` plan): always allow.
/// - hard-capped (`starter`): block once `remaining <= 0`. We gate on `remaining`
///   rather than `allowed` because Autumn's default `required_balance` is 1,
///   which would flip `allowed` to false at <1 GB left (~98%) — premature for a
///   GB-denominated meter. Fall back to `allowed` if `remaining` is absent.
fn decide_allowed(check: &CheckResponse) -> bool {
    match &check.balance {
        None => check.allowed,
        Some(balance) => {
            if balance.unlimited || balance.overage_allowed {
                true
            } else {
                match balance.remaining {
                    Some(remaining) => remaining > 0.0,
                    None => check.allowed,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resp(allowed: bool, balance: Option<FeatureBalance>) -> CheckResponse {
        CheckResponse { allowed, balance }
    }

    fn obj(unlimited: bool, overage_allowed: bool, remaining: Option<f64>) -> Option<FeatureBalance> {
        Some(FeatureBalance {
            unlimited,
            overage_allowed,
            remaining,
        })
    }

    #[test]
    fn no_balance_defers_to_allowed() {
        // No subscription: Autumn returns allowed:false + balance:null -> block.
        assert!(!decide_allowed(&resp(false, None)));
        assert!(decide_allowed(&resp(true, None)));
    }

    #[test]
    fn unlimited_allows() {
        assert!(decide_allowed(&resp(false, obj(true, false, Some(-5.0)))));
    }

    #[test]
    fn overage_allows() {
        // Usage-based `startup` plan is never blocked, even when over the
        // included amount.
        assert!(decide_allowed(&resp(false, obj(false, true, Some(-5.0)))));
    }

    #[test]
    fn hardcap_with_remaining_allows() {
        assert!(decide_allowed(&resp(true, obj(false, false, Some(10.0)))));
    }

    #[test]
    fn hardcap_depleted_blocks() {
        assert!(!decide_allowed(&resp(true, obj(false, false, Some(0.0)))));
        assert!(!decide_allowed(&resp(true, obj(false, false, Some(-1.0)))));
    }

    #[test]
    fn hardcap_without_remaining_falls_back_to_allowed() {
        assert!(decide_allowed(&resp(true, obj(false, false, None))));
        assert!(!decide_allowed(&resp(false, obj(false, false, None))));
    }

    #[test]
    fn deserializes_wire_shape_with_remaining_and_extra_fields() {
        // Real `/v1/check` body (snake_case, with fields we don't model).
        let json = r#"{
            "allowed": true,
            "customer_id": "org_123",
            "balance": {
                "feature_id": "logs",
                "granted": 50,
                "remaining": 12.5,
                "usage": 37.5,
                "unlimited": false,
                "overage_allowed": false,
                "next_reset_at": 1234567890
            },
            "flag": null
        }"#;
        let check: CheckResponse = serde_json::from_str(json).expect("parses");
        assert!(decide_allowed(&check));
        assert_eq!(check.balance.unwrap().remaining, Some(12.5));
    }

    #[test]
    fn deserializes_null_balance_no_subscription() {
        let json = r#"{"allowed": false, "balance": null, "flag": null}"#;
        let check: CheckResponse = serde_json::from_str(json).expect("parses");
        assert!(!decide_allowed(&check));
    }

    #[tokio::test]
    async fn fails_open_on_transport_error() {
        // Port 1 is closed => connection refused => we must fail open (allow),
        // never dropping customer data on a billing-provider outage.
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_string(),
            "http://127.0.0.1:1",
            60,
        );
        assert!(entitlements.is_allowed("org_123", "logs").await);
    }
}
