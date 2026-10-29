use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use maple_ingest::metrics;
use moka::future::Cache;
use reqwest::Client;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::{debug, error, info, warn, Instrument};
use uuid::Uuid;

const AUTUMN_API_VERSION: &str = "2.3.0";
const AUTUMN_TRACK_PATH: &str = "/v1/balances.track";
const AUTUMN_CHECK_PATH: &str = "/v1/balances.check";

pub(crate) struct UsageEvent {
    pub org_id: String,
    pub feature_id: &'static str,
    /// Quantity to bill for this event. Unit depends on `feature_id`: GB for
    /// `logs`/`traces`/`metrics`, a raw count for `browser_sessions` (session
    /// starts) and `product_events` (events).
    pub value: f64,
}

/// Where an org's usage is billed: `org_billing_links.billing_org_id`, or `None`
/// when the org has no link and bills as itself.
#[async_trait::async_trait]
pub(crate) trait BillingOrgLookup: Send + Sync {
    async fn fetch_billing_org_id(&self, org_id: &str) -> Result<Option<String>, String>;
}

/// Maps an org to the Autumn customer that pays for it. Successes are cached for
/// the TTL, "no link" included; failures are not, so the next caller retries.
/// A failed or slow refresh serves the last answer seen, so a Postgres outage
/// changes nothing for an org this process has already resolved.
#[derive(Clone)]
pub(crate) struct BillingOrgResolver {
    lookup: Arc<dyn BillingOrgLookup>,
    customers: Cache<String, String>,
    last_known: Cache<String, String>,
    /// Orgs whose lookup just failed: they skip Postgres briefly, so an outage
    /// costs one timeout per org rather than one per request.
    recent_failures: Cache<String, String>,
}

/// Bounds the Postgres read; past it the last-known answer is served.
const BILLING_LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a failed lookup is remembered before Postgres is tried again.
const BILLING_FAILURE_TTL: Duration = Duration::from_secs(10);

impl BillingOrgResolver {
    pub(crate) fn new(lookup: Arc<dyn BillingOrgLookup>, ttl: Duration) -> Self {
        Self::with_failure_ttl(lookup, ttl, BILLING_FAILURE_TTL)
    }

    fn with_failure_ttl(
        lookup: Arc<dyn BillingOrgLookup>,
        ttl: Duration,
        failure_ttl: Duration,
    ) -> Self {
        Self {
            lookup,
            customers: Cache::builder()
                .time_to_live(ttl)
                .max_capacity(10_000)
                .build(),
            last_known: Cache::builder()
                .time_to_idle(Duration::from_secs(24 * 60 * 60))
                .max_capacity(10_000)
                .build(),
            recent_failures: Cache::builder()
                .time_to_live(failure_ttl)
                .max_capacity(10_000)
                .build(),
        }
    }

    /// The Autumn `customer_id` for `org_id`. Concurrent misses share one lookup.
    pub(crate) async fn resolve(&self, org_id: &str) -> Result<String, String> {
        let fresh = match self.recent_failures.get(org_id).await {
            // Inside a failure's window: no Postgres, and the window is not extended.
            Some(error) => Err(error),
            None => {
                let looked_up = self
                    .customers
                    .try_get_with_by_ref(org_id, async {
                        let customer_id = tokio::time::timeout(
                            BILLING_LOOKUP_TIMEOUT,
                            self.lookup.fetch_billing_org_id(org_id),
                        )
                        .await
                        .map_err(|_| "billing org lookup timed out".to_owned())??
                        .unwrap_or_else(|| org_id.to_owned());
                        // Only on a real lookup: a cache hit on the request path writes nothing.
                        self.last_known
                            .insert(org_id.to_owned(), customer_id.clone())
                            .await;
                        Ok::<_, String>(customer_id)
                    })
                    .await
                    .map_err(|error| error.as_ref().clone());
                if let Err(error) = &looked_up {
                    // Once per failure window, not per request.
                    warn!(org_id, error = %error, "Billing org lookup failed");
                    self.recent_failures
                        .insert(org_id.to_owned(), error.clone())
                        .await;
                }
                looked_up
            }
        };
        match fresh {
            Ok(customer_id) => Ok(customer_id),
            Err(error) => match self.last_known.get(org_id).await {
                Some(stale) => {
                    // Per request while Postgres is down; the failure is logged once per window above.
                    debug!(org_id, error = %error, "Billing org lookup failed; serving last-known");
                    Ok(stale)
                }
                None => Err(error),
            },
        }
    }

    /// Every org bills as itself, as with no `org_billing_links` rows.
    #[cfg(test)]
    pub(crate) fn unlinked() -> Self {
        Self::new(Arc::new(NoBillingLinks), Duration::from_secs(60))
    }
}

#[cfg(test)]
struct NoBillingLinks;

#[cfg(test)]
#[async_trait::async_trait]
impl BillingOrgLookup for NoBillingLinks {
    async fn fetch_billing_org_id(&self, _org_id: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
}

#[derive(Clone)]
pub(crate) struct AutumnTracker {
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
    pub(crate) fn spawn(
        secret_key: String,
        api_url: &str,
        flush_interval_secs: u64,
        billing: BillingOrgResolver,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let api_url = api_url.trim_end_matches('/').to_owned();
        let flush_interval = Duration::from_secs(flush_interval_secs);

        let flusher = UsageFlusher {
            client: Client::new(),
            secret_key,
            api_url,
            billing,
        };
        tokio::spawn(flush_loop(rx, flusher, flush_interval));

        info!(flush_interval_secs, "Autumn usage tracker started");

        Self { tx }
    }

    pub(crate) fn track(&self, org_id: &str, feature_id: &'static str, value: f64) {
        drop(self.tx.send(UsageEvent {
            org_id: org_id.to_owned(),
            feature_id,
            value,
        }));
    }
}

type AccumulatorKey = (String, &'static str); // (org_id, feature_id)

/// Usage accumulated for one `(org_id, feature_id)` since the last successful
/// flush, together with the idempotency key that identifies it to Autumn.
///
/// The key is minted once, when the entry is created, and reused for every
/// retry of that entry. That is the whole point: a flush whose response is lost
/// (timeout, reset, 5xx after commit) leaves the entry in the accumulator to be
/// re-sent, and only a stable key lets Autumn recognize the retry instead of
/// billing it twice. It is dropped with the entry on success, so usage that
/// arrives afterwards starts a new entry under a new key.
struct PendingUsage {
    value: f64,
    idempotency_key: String,
    /// Once a batch has been attempted, its value, key and customer are
    /// immutable. New usage waits here until that batch succeeds, then starts
    /// under a new key.
    queued_value: f64,
    /// The billing customer resolved when the batch was sealed. `Some` means
    /// sealed; retries reuse it so a key never moves to another customer.
    customer_id: Option<String>,
}

impl PendingUsage {
    fn new(value: f64) -> Self {
        Self {
            value,
            idempotency_key: Uuid::new_v4().to_string(),
            queued_value: 0.0,
            customer_id: None,
        }
    }

    fn total(&self) -> f64 {
        self.value + self.queued_value
    }
}

/// Everything a flush needs to send usage to Autumn.
struct UsageFlusher {
    client: Client,
    secret_key: String,
    api_url: String,
    billing: BillingOrgResolver,
}

#[expect(
    clippy::cognitive_complexity,
    reason = "a `select!` loop whose arms are the accumulator's whole state machine; splitting an \
              arm out hides which branch mutates what"
)]
async fn flush_loop(
    mut rx: mpsc::UnboundedReceiver<UsageEvent>,
    flusher: UsageFlusher,
    flush_interval: Duration,
) {
    let mut accumulator: HashMap<AccumulatorKey, PendingUsage> = HashMap::new();
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
                let all_ok = flusher.flush(&mut accumulator).await;
                let flush_duration = flush_start.elapsed();

                if all_ok {
                    consecutive_failures = 0;
                    metrics::autumn_flush("ok", flush_duration.as_secs_f64());
                } else {
                    consecutive_failures += 1;
                    metrics::autumn_flush("error", flush_duration.as_secs_f64());

                    if consecutive_failures >= critical_threshold {
                        let total_pending_gb: f64 = accumulator.values().map(PendingUsage::total).sum();
                        error!(
                            consecutive_failures,
                            pending_entries = accumulator.len(),
                            total_pending_gb,
                            "CRITICAL: Autumn tracking has failed for ~5 minutes. Usage data is accumulating in memory."
                        );
                    }
                }

                // Update pending gauge. Note: this now sums mixed units across
                // features (GB for logs/traces/metrics, counts for browser_sessions
                // and product_events);
                // the metric name is kept as-is to avoid breaking existing dashboards.
                let total_pending: f64 = accumulator.values().map(PendingUsage::total).sum();
                metrics::autumn_pending_gb(total_pending);
            }

            event = rx.recv() => {
                if let Some(event) = event {
                    let pending = accumulator
                        .entry((event.org_id, event.feature_id))
                        .or_insert_with(|| PendingUsage::new(0.0));
                    if pending.customer_id.is_some() {
                        pending.queued_value += event.value;
                    } else {
                        pending.value += event.value;
                    }
                } else {
                    // Channel closed, do a final flush attempt
                    if !accumulator.is_empty() {
                        info!(
                            pending_entries = accumulator.len(),
                            "Autumn tracker shutting down, attempting final flush"
                        );
                        flusher.flush(&mut accumulator).await;
                    }
                    break;
                }
            }
        }
    }
}

impl UsageFlusher {
    /// Seals each unsealed entry under its org's billing customer, then sends
    /// every sealed entry. An entry whose lookup fails stays unsealed and keeps
    /// accumulating for the next flush. Returns whether everything succeeded.
    async fn flush(&self, accumulator: &mut HashMap<AccumulatorKey, PendingUsage>) -> bool {
        let mut all_ok = true;

        let unresolved: HashSet<String> = accumulator
            .iter()
            .filter(|(_, pending)| pending.customer_id.is_none())
            .map(|((org_id, _), _)| org_id.clone())
            .collect();
        // Concurrently: one slow lookup must not hold the whole flush.
        let mut lookups = tokio::task::JoinSet::new();
        for org_id in unresolved {
            let billing = self.billing.clone();
            lookups.spawn(async move {
                let result = billing.resolve(&org_id).await;
                (org_id, result)
            });
        }
        let mut resolved: HashMap<String, String> = HashMap::new();
        while let Some(joined) = lookups.join_next().await {
            let Ok((org_id, result)) = joined else {
                all_ok = false;
                continue;
            };
            match result {
                Ok(customer_id) => {
                    resolved.insert(org_id, customer_id);
                }
                Err(error) => {
                    warn!(
                        org_id,
                        error = %error,
                        "Billing org lookup failed; keeping usage for the next flush"
                    );
                    all_ok = false;
                }
            }
        }

        let entries: Vec<(AccumulatorKey, String, f64, String)> = accumulator
            .iter_mut()
            .filter_map(|(key, pending)| {
                if pending.customer_id.is_none() {
                    pending.customer_id = Some(resolved.get(&key.0)?.clone());
                }
                let customer_id = pending.customer_id.clone()?;
                Some((
                    key.clone(),
                    customer_id,
                    pending.value,
                    pending.idempotency_key.clone(),
                ))
            })
            .collect();

        for (key, customer_id, value, idempotency_key) in entries {
            let body = TrackRequest {
                customer_id: &customer_id,
                feature_id: key.1,
                value,
                idempotency_key,
            };
            if self.send(&key.0, &body).await {
                if let Some(completed) = accumulator.remove(&key) {
                    if completed.queued_value > 0.0 {
                        accumulator.insert(key, PendingUsage::new(completed.queued_value));
                    }
                }
            } else {
                all_ok = false;
            }
        }

        all_ok
    }

    async fn send(&self, org_id: &str, body: &TrackRequest<'_>) -> bool {
        let feature_id = body.feature_id;
        let billing_org_id = body.customer_id;
        let span = tracing::info_span!(
            "autumn.track",
            otel.kind = "client",
            "http.request.method" = "POST",
            "server.address" = "api.useautumn.com",
            "peer.service" = "autumn",
            "maple.billing_org_id" = billing_org_id,
        );
        let result: Result<reqwest::Response, reqwest::Error> = self
            .client
            .post(format!("{}{AUTUMN_TRACK_PATH}", self.api_url))
            .header("Authorization", format!("Bearer {}", self.secret_key))
            .header("x-api-version", AUTUMN_API_VERSION)
            .json(body)
            .send()
            .instrument(span)
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => true,
            Ok(resp) => {
                let status = resp.status();
                let body_text = resp.text().await.unwrap_or_default();
                warn!(
                    org_id,
                    billing_org_id,
                    feature_id,
                    status = %status,
                    body = %body_text,
                    "Autumn track request failed"
                );
                false
            }
            Err(err) => {
                warn!(
                    org_id,
                    billing_org_id,
                    feature_id,
                    error = %err,
                    "Autumn track request failed"
                );
                false
            }
        }
    }
}

/// Autumn-native entitlement gate, in front of a short-lived decision cache.
///
/// Autumn is asked whether an org may ingest a feature at most once per
/// `allow_ttl`; every other request for that `(org, feature)` is answered from
/// memory. Usage itself is never sent from here — `AutumnTracker` accumulates it
/// and flushes on its own interval, which is the only path that bills.
///
/// This deliberately trades exactness for latency. An org that crosses a hard
/// cap keeps ingesting for up to one TTL, so caps are soft by that much; denials
/// carry a much shorter TTL so a customer who has just paid is not held at 402.
/// The alternative — a `balances.check` lock plus a `balances.finalize` on every
/// request — put two blocking round trips to a third party in the ingest hot
/// path, and failed open on any of them anyway.
#[derive(Clone)]
pub(crate) struct AutumnEntitlements {
    client: maple_ingest::telemetry::HttpClient,
    secret_key: String,
    api_url: String,
    billing: BillingOrgResolver,
    decisions: Cache<DecisionKey, Decision>,
}

/// `(billing customer, feature)`: sub-orgs sharing a billing org share its decision.
/// `&'static str` because every feature id is a const or `Signal::path()`; it
/// keeps the cache key allocation-free on the hot side.
type DecisionKey = (String, &'static str);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Decision {
    Allow,
    Deny,
    /// Autumn gave no usable answer. Ingest proceeds (the fail-open rule this
    /// service has always had), but the entry expires on the short TTL so a
    /// blip resolves quickly instead of pinning an org open for a full minute.
    Unavailable,
}

impl Decision {
    const fn allowed(self) -> bool {
        !matches!(self, Self::Deny)
    }
}

/// Allows are cached for the long TTL, denials and fail-opens for the short one.
struct DecisionExpiry {
    allow_ttl: Duration,
    deny_ttl: Duration,
}

impl moka::Expiry<DecisionKey, Decision> for DecisionExpiry {
    fn expire_after_create(
        &self,
        _key: &DecisionKey,
        value: &Decision,
        _created_at: std::time::Instant,
    ) -> Option<Duration> {
        Some(match value {
            Decision::Allow => self.allow_ttl,
            Decision::Deny | Decision::Unavailable => self.deny_ttl,
        })
    }
}

#[derive(Serialize)]
struct CheckRequest<'a> {
    customer_id: &'a str,
    feature_id: &'a str,
}

impl AutumnEntitlements {
    pub(crate) fn new(
        client: impl Into<maple_ingest::telemetry::HttpClient>,
        secret_key: String,
        api_url: &str,
        allow_ttl_secs: u64,
        deny_ttl_secs: u64,
        billing: BillingOrgResolver,
    ) -> Self {
        let client = client.into();
        let api_url = api_url.trim_end_matches('/').to_owned();
        info!(
            allow_ttl_secs,
            deny_ttl_secs, "Autumn native billing enforcement enabled"
        );

        Self {
            client,
            secret_key,
            api_url,
            billing,
            decisions: Cache::builder()
                .expire_after(DecisionExpiry {
                    allow_ttl: Duration::from_secs(allow_ttl_secs),
                    deny_ttl: Duration::from_secs(deny_ttl_secs),
                })
                .max_capacity(10_000)
                .build(),
        }
    }

    /// Whether `org_id` may ingest `feature_id`, from cache when it is warm.
    ///
    /// Concurrent misses for the same key collapse into one request: moka's
    /// `get_with` runs the initializer once and hands the result to every
    /// waiter, so a cold whale org does not open a connection per request.
    pub(crate) async fn is_allowed(&self, org_id: &str, feature_id: &'static str) -> bool {
        let customer_id = match self.billing.resolve(org_id).await {
            Ok(customer_id) => customer_id,
            Err(error) => {
                // A sub-org has no plan of its own, so checking it as itself
                // would 402 its data. Fail open like any other billing outage.
                debug!(
                    org_id,
                    feature_id,
                    error = %error,
                    "Billing org lookup failed; failing open"
                );
                return true;
            }
        };
        tracing::Span::current().record("maple.billing_org_id", customer_id.as_str());

        let key = (customer_id, feature_id);
        if let Some(cached) = self.decisions.get(&key).await {
            tracing::Span::current().record("maple.ingest.cache_hit", true);
            metrics::autumn_entitlement_decision("hit");
            return cached.allowed();
        }

        tracing::Span::current().record("maple.ingest.cache_hit", false);
        metrics::autumn_entitlement_decision("miss");
        self.decisions
            .get_with_by_ref(&key, async {
                match self.post_check(org_id, &key.0, feature_id).await {
                    Some(true) => Decision::Allow,
                    Some(false) => Decision::Deny,
                    None => Decision::Unavailable,
                }
            })
            .await
            .allowed()
    }

    #[expect(
        clippy::cognitive_complexity,
        reason = "one HTTP round trip plus the response classification it exists to do"
    )]
    async fn post_check(
        &self,
        org_id: &str,
        billing_org_id: &str,
        feature_id: &str,
    ) -> Option<bool> {
        let body = CheckRequest {
            customer_id: billing_org_id,
            feature_id,
        };

        let span = tracing::info_span!(
            "autumn.check",
            otel.kind = "client",
            "http.request.method" = "POST",
            "server.address" = "api.useautumn.com",
            "peer.service" = "autumn",
            "maple.billing_org_id" = billing_org_id,
        );
        let result = self
            .client
            .post(format!("{}{}", self.api_url, AUTUMN_CHECK_PATH))
            .header("Authorization", format!("Bearer {}", self.secret_key))
            .header("x-api-version", AUTUMN_API_VERSION)
            .timeout(Duration::from_secs(5))
            .json(&body)
            .send()
            .instrument(span)
            .await;

        let response = match result {
            Ok(resp) if resp.status().is_success() => resp,
            Ok(resp) => {
                warn!(
                    org_id,
                    billing_org_id,
                    feature_id,
                    status = %resp.status(),
                    "Autumn check returned non-success; failing open"
                );
                return None;
            }
            Err(err) => {
                warn!(
                    org_id,
                    billing_org_id,
                    feature_id,
                    error = %err,
                    "Autumn check request failed; failing open"
                );
                return None;
            }
        };

        // Parse to an untyped Value rather than a fixed struct: Autumn's
        // `/v1/balances.check` body has shifted shape across versions (the
        // hosted REST body is flat with a numeric `balance`; the SDK's typed
        // view nests a `balance` object with `remaining`). A struct that assumes
        // one shape fails to decode the other and silently fails us open —
        // exactly the bug this replaces. Value parsing only fails on non-JSON.
        let text = match response.text().await {
            Ok(text) => text,
            Err(err) => {
                warn!(
                    org_id,
                    billing_org_id,
                    feature_id,
                    error = %err,
                    "Failed to read Autumn check response body; failing open"
                );
                return None;
            }
        };

        let value = match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => value,
            Err(err) => {
                warn!(
                    org_id,
                    billing_org_id,
                    feature_id,
                    error = %err,
                    body = %truncate_for_log(&text),
                    "Autumn check response is not JSON; failing open"
                );
                return None;
            }
        };

        let decision = decide_allowed(&value);
        match decision {
            None => {
                // Valid JSON we didn't recognize. Fail open, but log the body so
                // the real shape is visible and we can adapt decide_allowed.
                warn!(
                    org_id,
                    billing_org_id,
                    feature_id,
                    body = %truncate_for_log(&text),
                    "Unrecognized Autumn check response shape; failing open"
                );
            }
            Some(false) => {
                // A denial turns into a customer-visible 402 for up to one deny
                // TTL, so record what Autumn actually said. `allowed:false`
                // alone cannot distinguish "no subscription" from "in overage"
                // from "spend limit hit" — and those want opposite handling.
                warn!(
                    org_id,
                    billing_org_id,
                    feature_id,
                    body = %truncate_for_log(&text),
                    "Autumn denied ingestion; recording response body for the denial reason"
                );
            }
            Some(true) => {}
        }
        decision
    }
}

fn truncate_for_log(body: &str) -> String {
    const MAX: usize = 512;
    if body.len() <= MAX {
        return body.to_owned();
    }
    // Step back to a char boundary so we never slice through a UTF-8 sequence.
    let mut end = MAX;
    while end > 0 && !body.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &body[..end])
}

/// Decide whether an org may ingest, from Autumn's `/v1/balances.check` body.
/// Tolerant of both the flat hosted REST shape (`balance` is a number,
/// `unlimited` / `overage_allowed` top-level) and the SDK's nested shape
/// (`balance` is an object carrying `remaining` / `unlimited` /
/// `overage_allowed`).
///
/// Returns `None` when the JSON carries none of the fields we understand, so the
/// caller can log the body and fail open rather than guess.
///
/// Autumn's explicit `allowed` field is authoritative. This matters for native
/// customer spend limits: a plan can allow overage generally while a customer
/// control denies the next event. Older response shapes without `allowed` fall
/// back to unlimited/overage/remaining for compatibility.
fn decide_allowed(value: &serde_json::Value) -> Option<bool> {
    let as_bool =
        |v: &serde_json::Value, key: &str| v.get(key).and_then(serde_json::Value::as_bool);

    if let Some(allowed) = as_bool(value, "allowed") {
        return Some(allowed);
    }

    let mut understood = false;
    let mut unlimited = as_bool(value, "unlimited").unwrap_or(false);
    let mut overage = as_bool(value, "overage_allowed").unwrap_or(false);
    let mut remaining: Option<f64> = None;

    if unlimited || overage {
        understood = true;
    }

    match value.get("balance") {
        Some(serde_json::Value::Number(n)) => {
            understood = true;
            remaining = n.as_f64();
        }
        Some(serde_json::Value::Object(obj)) => {
            understood = true;
            if obj.get("unlimited").and_then(serde_json::Value::as_bool) == Some(true) {
                unlimited = true;
            }
            if obj
                .get("overage_allowed")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
            {
                overage = true;
            }
            remaining = obj.get("remaining").and_then(serde_json::Value::as_f64);
        }
        _ => {}
    }

    if !understood {
        return None;
    }

    if unlimited || overage {
        return Some(true);
    }
    if let Some(remaining) = remaining {
        return Some(remaining > 0.0);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::Router;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    fn decide(json: &str) -> Option<bool> {
        let value = serde_json::from_str::<serde_json::Value>(json).expect("valid json");
        decide_allowed(&value)
    }

    // --- Flat hosted REST shape: `balance` is a number; unlimited /
    // overage_allowed are top-level. This is the shape that broke decode before. ---

    #[test]
    fn flat_hardcap_with_remaining_allows() {
        assert_eq!(
            decide(
                r#"{"allowed": true, "balance": 12.5, "unlimited": false, "overage_allowed": false}"#
            ),
            Some(true)
        );
    }

    #[test]
    fn flat_hardcap_depleted_blocks() {
        // allowed:false at remaining 0 — and even if `allowed` lagged, remaining
        // gates the decision.
        assert_eq!(
            decide(
                r#"{"allowed": false, "balance": 0, "unlimited": false, "overage_allowed": false}"#
            ),
            Some(false)
        );
    }

    #[test]
    fn explicit_denial_wins_even_when_balance_remains() {
        assert_eq!(
            decide(
                r#"{"allowed": false, "balance": 0.5, "unlimited": false, "overage_allowed": false}"#
            ),
            Some(false)
        );
    }

    #[test]
    fn flat_unlimited_allows() {
        assert_eq!(
            decide(
                r#"{"allowed": true, "balance": 0, "unlimited": true, "overage_allowed": false}"#
            ),
            Some(true)
        );
    }

    #[test]
    fn flat_overage_allows() {
        // Usage-based `startup` plan: never blocked even when over included.
        assert_eq!(
            decide(
                r#"{"allowed": true, "balance": -5, "unlimited": false, "overage_allowed": true}"#
            ),
            Some(true)
        );
    }

    // The SDK shape nests `remaining` under `balance`.

    #[test]
    fn nested_balance_object_with_remaining_allows() {
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
        assert_eq!(decide(json), Some(true));
    }

    #[test]
    fn nested_balance_object_depleted_blocks() {
        let json = r#"{"allowed": false, "balance": {"remaining": 0, "unlimited": false, "overage_allowed": false}, "flag": null}"#;
        assert_eq!(decide(json), Some(false));
    }

    #[test]
    fn native_customer_cap_denial_wins_over_plan_overage() {
        let json = r#"{"allowed": false, "balance": {"remaining": -5, "unlimited": false, "overage_allowed": true}}"#;
        assert_eq!(decide(json), Some(false));
    }

    // Without a balance or subscription, defer to `allowed`.

    #[test]
    fn null_balance_no_subscription_blocks() {
        assert_eq!(
            decide(r#"{"allowed": false, "balance": null, "flag": null}"#),
            Some(false)
        );
    }

    #[test]
    fn allowed_only_no_balance_field() {
        assert_eq!(decide(r#"{"allowed": true}"#), Some(true));
        assert_eq!(decide(r#"{"allowed": false}"#), Some(false));
    }

    // Unknown shapes return None so the caller logs and fails open.

    #[test]
    fn unrecognized_shape_returns_none() {
        assert_eq!(decide(r#"{"error": "internal", "code": 500}"#), None);
        assert_eq!(decide(r"{}"), None);
    }

    #[tokio::test]
    async fn fails_open_on_transport_error() {
        // Port 1 is closed => connection refused => we must fail open (allow),
        // never dropping customer data on a billing-provider outage.
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_owned(),
            "http://127.0.0.1:1",
            60,
            5,
            BillingOrgResolver::unlinked(),
        );
        assert!(entitlements.is_allowed("org_123", "logs").await);
    }

    async fn record_check(
        State(tx): State<mpsc::UnboundedSender<(serde_json::Value, Option<String>)>>,
        headers: axum::http::HeaderMap,
        body: String,
    ) -> axum::Json<serde_json::Value> {
        let api_version = headers
            .get("x-api-version")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        drop(tx.send((serde_json::from_str(&body).unwrap(), api_version)));
        axum::Json(serde_json::json!({
            "allowed": true,
            "balance": {
                "remaining": 12.5,
                "unlimited": false,
                "overage_allowed": false
            }
        }))
    }

    #[tokio::test]
    async fn check_uses_v23_canonical_route_and_header() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(AUTUMN_CHECK_PATH, post(record_check))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_owned(),
            &format!("http://{addr}"),
            60,
            5,
            BillingOrgResolver::unlinked(),
        );
        assert!(entitlements.is_allowed("org_123", "logs").await);

        let (body, api_version) = rx.recv().await.expect("check request");
        assert_eq!(body["customer_id"], "org_123");
        assert_eq!(body["feature_id"], "logs");
        assert_eq!(api_version.as_deref(), Some(AUTUMN_API_VERSION));
    }

    /// A `/v1/balances.check` stub that counts calls and answers `allowed` from
    /// a flag the test can flip, so a test can prove both that a decision was
    /// reused and that it was eventually re-fetched.
    #[derive(Clone)]
    struct CheckStub {
        calls: Arc<AtomicUsize>,
        allow: Arc<AtomicBool>,
        delay: Duration,
    }

    async fn record_counted_check(State(stub): State<CheckStub>) -> axum::Json<serde_json::Value> {
        stub.calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(stub.delay).await;
        axum::Json(serde_json::json!({
            "allowed": stub.allow.load(Ordering::SeqCst),
            "balance": { "remaining": 12.5, "unlimited": false, "overage_allowed": false }
        }))
    }

    async fn spawn_check_stub(allow: bool, delay: Duration) -> (String, CheckStub) {
        let stub = CheckStub {
            calls: Arc::new(AtomicUsize::new(0)),
            allow: Arc::new(AtomicBool::new(allow)),
            delay,
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(AUTUMN_CHECK_PATH, post(record_counted_check))
            .with_state(stub.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), stub)
    }

    #[tokio::test]
    async fn repeated_checks_hit_autumn_once_per_ttl() {
        // The whole point of the change: ingest requests after the first are
        // answered from memory, not from a blocking call to a third party.
        let (api_url, stub) = spawn_check_stub(true, Duration::ZERO).await;
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_owned(),
            &api_url,
            60,
            5,
            BillingOrgResolver::unlinked(),
        );

        for _ in 0..25 {
            assert!(entitlements.is_allowed("org_cached", "logs").await);
        }

        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn decisions_are_scoped_to_the_org_and_feature() {
        let (api_url, stub) = spawn_check_stub(true, Duration::ZERO).await;
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_owned(),
            &api_url,
            60,
            5,
            BillingOrgResolver::unlinked(),
        );

        assert!(entitlements.is_allowed("org_a", "logs").await);
        assert!(entitlements.is_allowed("org_a", "traces").await);
        assert!(entitlements.is_allowed("org_b", "logs").await);
        assert!(entitlements.is_allowed("org_a", "logs").await);

        assert_eq!(stub.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn concurrent_misses_collapse_into_one_check() {
        // Without single-flight, a cold whale org opens one connection per
        // in-flight request the moment its entry expires.
        let (api_url, stub) = spawn_check_stub(true, Duration::from_millis(50)).await;
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_owned(),
            &api_url,
            60,
            5,
            BillingOrgResolver::unlinked(),
        );

        let mut handles = Vec::new();
        for _ in 0..32 {
            let entitlements = entitlements.clone();
            handles.push(tokio::spawn(async move {
                entitlements.is_allowed("org_stampede", "traces").await
            }));
        }
        for handle in handles {
            assert!(handle.await.unwrap());
        }

        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_denial_expires_on_the_short_ttl_so_a_paying_org_recovers() {
        // The asymmetry that makes the cache safe to ship: an org that has just
        // paid is held at 402 for the deny TTL, not the allow TTL.
        let (api_url, stub) = spawn_check_stub(false, Duration::ZERO).await;
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_owned(),
            &api_url,
            3_600,
            1,
            BillingOrgResolver::unlinked(),
        );

        assert!(!entitlements.is_allowed("org_lapsed", "logs").await);
        assert!(!entitlements.is_allowed("org_lapsed", "logs").await);
        assert_eq!(stub.calls.load(Ordering::SeqCst), 1, "denial is cached too");

        stub.allow.store(true, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(1_200)).await;

        assert!(entitlements.is_allowed("org_lapsed", "logs").await);
        assert_eq!(stub.calls.load(Ordering::SeqCst), 2);

        // ...and the allow it just learned rides the hour-long TTL.
        assert!(entitlements.is_allowed("org_lapsed", "logs").await);
        assert_eq!(stub.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_unreachable_autumn_fails_open_without_pinning_the_org_open() {
        // Port 1 is closed => connection refused => allow, but on the SHORT TTL:
        // a fail-open must not hold an org open for a full allow window.
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_owned(),
            "http://127.0.0.1:1",
            3_600,
            1,
            BillingOrgResolver::unlinked(),
        );
        assert!(entitlements.is_allowed("org_outage", "logs").await);
        assert_eq!(
            entitlements
                .decisions
                .get(&("org_outage".to_owned(), "logs"))
                .await,
            Some(Decision::Unavailable)
        );
    }

    /// Every fake Autumn handler reports what it received down the same channel:
    /// the decoded body, plus the `x-api-version` header if the client sent one.
    type TrackSender = mpsc::UnboundedSender<(serde_json::Value, Option<String>)>;

    // One stable idempotency key per accumulated entry across retries.

    /// Stand-in for Autumn's `/v1/balances.track`. Records every body and API
    /// version it receives and answers with `status`, so a test can drive the
    /// flush loop through a failure and inspect what the retry sent.
    async fn record_track(
        State((tx, status)): State<(TrackSender, StatusCode)>,

        headers: axum::http::HeaderMap,
        body: String,
    ) -> StatusCode {
        let api_version = headers
            .get("x-api-version")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        drop(tx.send((serde_json::from_str(&body).unwrap(), api_version)));
        status
    }

    async fn spawn_autumn_stub(
        status: StatusCode,
    ) -> (
        String,
        mpsc::UnboundedReceiver<(serde_json::Value, Option<String>)>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(AUTUMN_TRACK_PATH, post(record_track))
            .with_state((tx, status));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), rx)
    }

    async fn record_track_fail_once(
        State((tx, attempts)): State<(TrackSender, Arc<AtomicUsize>)>,

        headers: axum::http::HeaderMap,
        body: String,
    ) -> StatusCode {
        let api_version = headers
            .get("x-api-version")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        drop(tx.send((serde_json::from_str(&body).unwrap(), api_version)));
        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            StatusCode::INTERNAL_SERVER_ERROR
        } else {
            StatusCode::OK
        }
    }

    async fn spawn_fail_once_autumn_stub() -> (
        String,
        mpsc::UnboundedReceiver<(serde_json::Value, Option<String>)>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(AUTUMN_TRACK_PATH, post(record_track_fail_once))
            .with_state((tx, Arc::new(AtomicUsize::new(0))));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test]
    async fn a_failed_flush_retries_under_the_same_idempotency_key() {
        // The bug this pins: a per-attempt key means Autumn cannot recognize the
        // retry of a track it already committed, and bills the usage twice.
        let (api_url, mut rx) = spawn_autumn_stub(StatusCode::INTERNAL_SERVER_ERROR).await;
        let tracker = AutumnTracker::spawn(
            "sk_test".to_owned(),
            &api_url,
            1,
            BillingOrgResolver::unlinked(),
        );
        tracker.track("org_retry", "logs", 1.5);

        let (first, first_api_version) = rx.recv().await.expect("first flush attempt");
        let (second, second_api_version) = rx.recv().await.expect("retry after the 500");

        assert_eq!(
            first["idempotency_key"], second["idempotency_key"],
            "retry must reuse the key so Autumn can dedupe it"
        );
        // The entry survived the failure intact, so the retry re-sends the same
        // accumulated value rather than a fragment of it.
        assert_eq!(first["value"], second["value"]);
        assert_eq!(first["customer_id"], "org_retry");
        assert_eq!(first["feature_id"], "logs");
        assert_eq!(first_api_version.as_deref(), Some(AUTUMN_API_VERSION));
        assert_eq!(second_api_version.as_deref(), Some(AUTUMN_API_VERSION));
    }

    #[tokio::test]
    async fn usage_after_a_successful_flush_gets_a_fresh_key() {
        // The other half: once an entry is acknowledged it is gone, so later
        // usage for the same (org, feature) must not reuse its key — Autumn
        // would dedupe it away and we'd under-bill.
        let (api_url, mut rx) = spawn_autumn_stub(StatusCode::OK).await;
        let tracker = AutumnTracker::spawn(
            "sk_test".to_owned(),
            &api_url,
            1,
            BillingOrgResolver::unlinked(),
        );

        tracker.track("org_fresh", "traces", 2.0);
        let (first, first_api_version) = rx.recv().await.expect("first flush");
        tracker.track("org_fresh", "traces", 3.0);
        let (second, second_api_version) = rx.recv().await.expect("second flush");

        assert_ne!(first["idempotency_key"], second["idempotency_key"]);
        assert_eq!(first["value"], 2.0);
        assert_eq!(second["value"], 3.0);
        assert_eq!(first_api_version.as_deref(), Some(AUTUMN_API_VERSION));
        assert_eq!(second_api_version.as_deref(), Some(AUTUMN_API_VERSION));
    }

    #[tokio::test]
    async fn usage_after_a_failed_flush_waits_for_a_fresh_batch_key() {
        let (api_url, mut rx) = spawn_fail_once_autumn_stub().await;
        let tracker = AutumnTracker::spawn(
            "sk_test".to_owned(),
            &api_url,
            1,
            BillingOrgResolver::unlinked(),
        );

        tracker.track("org_queued", "metrics", 1.5);
        let (failed, _) = rx.recv().await.expect("failed first flush");
        tokio::time::sleep(Duration::from_millis(50)).await;
        tracker.track("org_queued", "metrics", 2.0);

        let (retry, _) = rx.recv().await.expect("retry of sealed batch");
        let (queued, _) = rx
            .recv()
            .await
            .expect("fresh batch for newly arrived usage");

        assert_eq!(failed["idempotency_key"], retry["idempotency_key"]);
        assert_eq!(failed["value"], 1.5);
        assert_eq!(retry["value"], 1.5);
        assert_ne!(retry["idempotency_key"], queued["idempotency_key"]);
        assert_eq!(queued["value"], 2.0);
    }

    /// `org_billing_links` in memory, with a switch that fails every lookup.
    #[derive(Default)]
    struct StubLinks {
        links: std::sync::Mutex<HashMap<String, String>>,
        failing: AtomicBool,
        calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl BillingOrgLookup for StubLinks {
        async fn fetch_billing_org_id(&self, org_id: &str) -> Result<Option<String>, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.failing.load(Ordering::SeqCst) {
                return Err("simulated postgres outage".to_owned());
            }
            Ok(self.links.lock().unwrap().get(org_id).cloned())
        }
    }

    fn stub_links(links: &[(&str, &str)]) -> Arc<StubLinks> {
        let stub = StubLinks::default();
        stub.links.lock().unwrap().extend(
            links
                .iter()
                .map(|(org, billing)| ((*org).to_owned(), (*billing).to_owned())),
        );
        Arc::new(stub)
    }

    /// Failures are remembered for 50ms, so a test sees the next lookup recover.
    fn resolver_over(links: &Arc<StubLinks>) -> BillingOrgResolver {
        BillingOrgResolver::with_failure_ttl(
            Arc::<StubLinks>::clone(links),
            Duration::from_secs(60),
            Duration::from_millis(50),
        )
    }

    #[tokio::test]
    async fn resolver_caches_successes_but_not_failures() {
        let links = stub_links(&[("org_sub", "org_main")]);
        let resolver = resolver_over(&links);

        links.failing.store(true, Ordering::SeqCst);
        assert!(resolver.resolve("org_sub").await.is_err());
        links.failing.store(false, Ordering::SeqCst);
        // A failure is remembered briefly: the retry right after it skips Postgres.
        assert!(resolver.resolve("org_sub").await.is_err());
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(resolver.resolve("org_sub").await.unwrap(), "org_main");
        assert_eq!(resolver.resolve("org_sub").await.unwrap(), "org_main");
        assert_eq!(
            links.calls.load(Ordering::SeqCst),
            2,
            "only the success is cached"
        );

        // "No link" is a success too: the org bills as itself, from cache.
        assert_eq!(resolver.resolve("org_solo").await.unwrap(), "org_solo");
        assert_eq!(resolver.resolve("org_solo").await.unwrap(), "org_solo");
        assert_eq!(links.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_failure_window_is_not_extended_by_requests_inside_it() {
        let links = stub_links(&[("org_sub", "org_main")]);
        // A 600ms window, checked at 200ms (inside) and 700ms: past the window measured from the
        // failure, but before one restarted by the 200ms check would close (800ms). 100ms margins.
        let resolver = BillingOrgResolver::with_failure_ttl(
            Arc::<StubLinks>::clone(&links),
            Duration::from_secs(60),
            Duration::from_millis(600),
        );
        links.failing.store(true, Ordering::SeqCst);
        assert!(resolver.resolve("org_sub").await.is_err());
        links.failing.store(false, Ordering::SeqCst);

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            resolver.resolve("org_sub").await.is_err(),
            "still inside the window"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(resolver.resolve("org_sub").await.unwrap(), "org_main");
    }

    #[tokio::test]
    async fn a_failed_refresh_serves_the_last_known_billing_org() {
        let links = stub_links(&[("org_sub", "org_main")]);
        let resolver =
            BillingOrgResolver::new(Arc::<StubLinks>::clone(&links), Duration::from_millis(20));
        assert_eq!(resolver.resolve("org_sub").await.unwrap(), "org_main");

        tokio::time::sleep(Duration::from_millis(60)).await;
        links.failing.store(true, Ordering::SeqCst);
        assert_eq!(resolver.resolve("org_sub").await.unwrap(), "org_main");
        // An org never resolved has nothing to fall back to.
        assert!(resolver.resolve("org_new").await.is_err());
    }

    #[tokio::test]
    async fn an_unlinked_org_tracks_to_itself() {
        let (api_url, mut rx) = spawn_autumn_stub(StatusCode::OK).await;
        let links = stub_links(&[("org_sub", "org_main")]);
        let tracker =
            AutumnTracker::spawn("sk_test".to_owned(), &api_url, 1, resolver_over(&links));

        tracker.track("org_solo", "logs", 1.0);
        let (body, _) = rx.recv().await.expect("track");

        assert_eq!(body["customer_id"], "org_solo");
        assert_eq!(body["value"], 1.0);
    }

    #[tokio::test]
    async fn a_linked_org_tracks_to_its_billing_org() {
        let (api_url, mut rx) = spawn_autumn_stub(StatusCode::OK).await;
        let links = stub_links(&[("org_sub", "org_main")]);
        let tracker =
            AutumnTracker::spawn("sk_test".to_owned(), &api_url, 1, resolver_over(&links));

        tracker.track("org_sub", "traces", 2.5);
        let (body, _) = rx.recv().await.expect("track");

        assert_eq!(body["customer_id"], "org_main");
        assert_eq!(body["feature_id"], "traces");
        assert_eq!(body["value"], 2.5);
    }

    #[tokio::test]
    async fn a_failed_billing_lookup_keeps_usage_for_the_next_flush() {
        let (api_url, mut rx) = spawn_autumn_stub(StatusCode::OK).await;
        let links = stub_links(&[("org_sub", "org_main")]);
        links.failing.store(true, Ordering::SeqCst);
        let tracker =
            AutumnTracker::spawn("sk_test".to_owned(), &api_url, 1, resolver_over(&links));

        tracker.track("org_sub", "logs", 1.5);
        tokio::time::sleep(Duration::from_millis(1_300)).await;
        assert!(
            links.calls.load(Ordering::SeqCst) >= 1,
            "a flush tried the lookup"
        );
        assert!(
            rx.try_recv().is_err(),
            "nothing is sent without a billing org"
        );

        tracker.track("org_sub", "logs", 2.0);
        links.failing.store(false, Ordering::SeqCst);
        let (body, _) = rx.recv().await.expect("track once the lookup recovers");

        assert_eq!(body["customer_id"], "org_main");
        assert_eq!(
            body["value"], 3.5,
            "the held usage was neither dropped nor split"
        );
    }

    #[tokio::test]
    async fn a_linked_org_is_checked_against_its_billing_org() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route(AUTUMN_CHECK_PATH, post(record_check))
            .with_state(tx);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let links = stub_links(&[("org_sub", "org_main")]);
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_owned(),
            &format!("http://{addr}"),
            60,
            5,
            resolver_over(&links),
        );

        assert!(entitlements.is_allowed("org_sub", "logs").await);

        let (body, _) = rx.recv().await.expect("check request");
        assert_eq!(body["customer_id"], "org_main");
    }

    #[tokio::test]
    async fn sub_orgs_of_one_billing_org_share_its_decision() {
        let (api_url, stub) = spawn_check_stub(false, Duration::ZERO).await;
        let links = stub_links(&[("org_sub_a", "org_main"), ("org_sub_b", "org_main")]);
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_owned(),
            &api_url,
            60,
            60,
            resolver_over(&links),
        );

        assert!(!entitlements.is_allowed("org_sub_a", "logs").await);
        assert!(!entitlements.is_allowed("org_sub_b", "logs").await);
        assert!(!entitlements.is_allowed("org_main", "logs").await);
        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failed_billing_lookup_fails_open_without_checking() {
        // Checking the sub-org as itself would 402 it: it has no plan of its own.
        let (api_url, stub) = spawn_check_stub(false, Duration::ZERO).await;
        let links = stub_links(&[("org_sub", "org_main")]);
        links.failing.store(true, Ordering::SeqCst);
        let entitlements = AutumnEntitlements::new(
            Client::new(),
            "sk_test".to_owned(),
            &api_url,
            60,
            60,
            resolver_over(&links),
        );

        assert!(entitlements.is_allowed("org_sub", "logs").await);
        assert_eq!(stub.calls.load(Ordering::SeqCst), 0);

        // Only the failure's short window is remembered; after it, the next request checks for real.
        links.failing.store(false, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(!entitlements.is_allowed("org_sub", "logs").await);
        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
    }
}
