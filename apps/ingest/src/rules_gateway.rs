//! Customer ingest rules in the gateway: each org's compiled rules, cached, and
//! the per-rule counts flushed to `org_ingest_rule_stats`. The engine itself is
//! `maple_ingest::ingest_rules`; the contract is `docs/ingest-rules.md`.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use maple_ingest::ingest_rules::{CompiledRules, IngestRuleSpec, RuleCounters, RuleStats};
use maple_ingest::metrics;
use moka::future::Cache;
use tracing::warn;

use crate::KeyStore;

const HOUR_MS: i64 = 60 * 60 * 1000;
/// Rows per `INSERT`: 8 parameters each, far below Postgres' 65535 limit.
const STAT_ROWS_PER_STATEMENT: usize = 500;
/// Consecutive failed flushes after which the pending counts are given up.
const MAX_FAILED_FLUSHES: u32 = 10;
/// After a failed lookup, the next one waits this long; last-known rules are served meanwhile.
const FETCH_RETRY_BACKOFF: Duration = Duration::from_secs(1);
/// How long last-known rules may stand in for a failing store.
const LAST_KNOWN_TTL: Duration = Duration::from_hours(24);

/// An org's enabled rules as stored, in `position` order, with its hash salt.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct IngestRuleRows {
    /// (rule id, `spec_json` text).
    pub(crate) rules: Vec<(String, String)>,
    /// Empty when the org has no settings row yet (then no hash rule exists either).
    pub(crate) hash_salt: String,
}

/// One `org_ingest_rule_stats` row's worth of counts to add.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IngestRuleStatRow {
    pub(crate) org_id: String,
    pub(crate) rule_id: String,
    /// Start of the UTC hour, in epoch milliseconds.
    pub(crate) bucket_ms: i64,
    pub(crate) signal: &'static str,
    pub(crate) counts: RuleCounters,
}

/// One org's compiled rules, with shared ids so recording stats allocates nothing.
pub(crate) struct OrgRules {
    pub(crate) compiled: CompiledRules,
    org_id: Arc<str>,
    /// Indexed like `compiled.rule_ids()`.
    rule_ids: Vec<Arc<str>>,
}

impl OrgRules {
    fn new(org_id: &str, compiled: CompiledRules) -> Self {
        let rule_ids = compiled.rule_ids().iter().map(|id| Arc::from(id.as_str())).collect();
        Self {
            compiled,
            org_id: Arc::from(org_id),
            rule_ids,
        }
    }
}

/// The org's rules could not be loaded and none were loaded before: refuse rather than store raw data.
#[derive(Debug)]
pub(crate) struct RulesUnavailable;

/// Each org's compiled rules: cached for a TTL, concurrent misses share one fetch,
/// and a failing store serves the last good load (or refuses when there is none).
pub(crate) struct IngestRuleResolver {
    store: Arc<dyn KeyStore>,
    /// `INGEST_RULES_ENABLED`; when false the store is never queried.
    enabled: bool,
    /// Successful loads only.
    cache: Cache<String, Arc<OrgRules>>,
    /// Bounded, so orgs that stop sending age out.
    last_known: Cache<String, Arc<OrgRules>>,
    /// Orgs whose last lookup failed less than `FETCH_RETRY_BACKOFF` ago.
    recent_failures: Cache<String, ()>,
    disabled: Arc<OrgRules>,
}

impl IngestRuleResolver {
    pub(crate) fn new(store: Arc<dyn KeyStore>, enabled: bool, ttl: Duration, capacity: u64) -> Self {
        Self {
            store,
            enabled,
            cache: Cache::builder()
                .time_to_live(ttl.max(Duration::from_secs(1)))
                .max_capacity(capacity)
                .build(),
            last_known: Cache::builder()
                .time_to_live(LAST_KNOWN_TTL)
                .max_capacity(capacity)
                .build(),
            recent_failures: Cache::builder()
                .time_to_live(FETCH_RETRY_BACKOFF)
                .max_capacity(capacity)
                .build(),
            disabled: Arc::new(OrgRules::new("", CompiledRules::default())),
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    /// The org's rules. A failed lookup serves the last good load; with none, the request is refused.
    pub(crate) async fn resolve_rules(&self, org_id: &str) -> Result<Arc<OrgRules>, RulesUnavailable> {
        if !self.enabled {
            return Ok(Arc::clone(&self.disabled));
        }
        if let Some(rules) = self.cache.get(org_id).await {
            return Ok(rules);
        }
        if self.recent_failures.contains_key(org_id) {
            return self.fallback(org_id).await;
        }
        let store = Arc::clone(&self.store);
        let last_known = self.last_known.clone();
        let key = org_id.to_owned();
        // `try_get_with` runs one fetch per org however many requests miss at once; errors are not cached.
        let loaded = self
            .cache
            .try_get_with(org_id.to_owned(), async move {
                let rows = store.fetch_ingest_rules(&key).await?;
                let rules = Arc::new(OrgRules::new(&key, compile_rows(&key, rows)));
                last_known.insert(key, Arc::clone(&rules)).await;
                Ok::<_, String>(rules)
            })
            .await;
        match loaded {
            Ok(rules) => Ok(rules),
            Err(error) => {
                metrics::ingest_rules_fetch_failed(org_id);
                warn!(org_id, error = %error, "Ingest rule lookup failed");
                self.recent_failures.insert(org_id.to_owned(), ()).await;
                self.fallback(org_id).await
            }
        }
    }

    async fn fallback(&self, org_id: &str) -> Result<Arc<OrgRules>, RulesUnavailable> {
        self.last_known.get(org_id).await.ok_or(RulesUnavailable)
    }

    /// Ends the cached entry and any failure backoff early, so the next request reloads.
    #[cfg(test)]
    pub(crate) async fn expire(&self, org_id: &str) {
        self.cache.invalidate(org_id).await;
        self.recent_failures.invalidate(org_id).await;
    }
}

/// Parses and compiles stored rules; one that fails is skipped, logged and counted.
fn compile_rows(org_id: &str, rows: IngestRuleRows) -> CompiledRules {
    let mut unparsable = 0u64;
    let specs = rows
        .rules
        .into_iter()
        .filter_map(|(id, json)| match serde_json::from_str::<IngestRuleSpec>(&json) {
            Ok(spec) => Some((id, spec)),
            Err(error) => {
                warn!(org_id, rule_id = %id, error = %error, "Ingest rule spec does not parse; skipped");
                unparsable += 1;
                None
            }
        })
        .collect();
    let (compiled, invalid) = CompiledRules::compile(specs, rows.hash_salt);
    for rule in &invalid {
        warn!(org_id, rule_id = %rule.id, reason = %rule.reason, "Ingest rule does not compile; skipped");
    }
    let skipped = unparsable.saturating_add(u64::try_from(invalid.len()).unwrap_or(u64::MAX));
    if skipped > 0 {
        metrics::ingest_rules_invalid(org_id, skipped);
    }
    compiled
}

/// (org, rule, UTC hour in epoch ms, signal); the ids are shared with `OrgRules`.
type StatKey = (Arc<str>, Arc<str>, i64, &'static str);

/// Per-rule counts summed per (org, rule, UTC hour, signal) until the next flush.
/// Sharded, so concurrent requests rarely contend.
#[derive(Default)]
pub(crate) struct IngestRuleStatsSink {
    pending: DashMap<StatKey, RuleCounters>,
    failed_flushes: AtomicU32,
}

fn add_counts(total: &mut RuleCounters, more: &RuleCounters) {
    total.matched += more.matched;
    total.dropped += more.dropped;
    total.dropped_bytes += more.dropped_bytes;
    total.redacted_values += more.redacted_values;
}

impl IngestRuleStatsSink {
    /// Adds one written payload's counts; free when no rule matched.
    pub(crate) fn record(&self, signal: &'static str, rules: &OrgRules, stats: &RuleStats, now_ms: i64) {
        if stats.total.matched == 0 {
            return;
        }
        let bucket_ms = now_ms - now_ms.rem_euclid(HOUR_MS);
        for (rule_id, counters) in rules.rule_ids.iter().zip(&stats.per_rule) {
            if counters.matched == 0 {
                continue;
            }
            let key = (Arc::clone(&rules.org_id), Arc::clone(rule_id), bucket_ms, signal);
            add_counts(&mut self.pending.entry(key).or_default(), counters);
        }
    }

    /// Removes and returns every pending row; counts added meanwhile wait for the next flush.
    fn take(&self) -> Vec<IngestRuleStatRow> {
        let keys: Vec<StatKey> = self.pending.iter().map(|entry| entry.key().clone()).collect();
        keys.into_iter()
            .filter_map(|key| self.pending.remove(&key))
            .map(|((org_id, rule_id, bucket_ms, signal), counts)| IngestRuleStatRow {
                org_id: org_id.to_string(),
                rule_id: rule_id.to_string(),
                bucket_ms,
                signal,
                counts,
            })
            .collect()
    }

    fn restore(&self, rows: Vec<IngestRuleStatRow>) {
        for row in rows {
            let key = (Arc::from(row.org_id), Arc::from(row.rule_id), row.bucket_ms, row.signal);
            add_counts(&mut self.pending.entry(key).or_default(), &row.counts);
        }
    }

    /// Writes the pending counts. A failure keeps them for the next flush, up to
    /// `MAX_FAILED_FLUSHES` in a row, after which they are dropped and counted.
    pub(crate) async fn flush(&self, store: &dyn KeyStore) {
        let rows = self.take();
        if rows.is_empty() {
            return;
        }
        let mut failed: Vec<IngestRuleStatRow> = Vec::new();
        for chunk in rows.chunks(STAT_ROWS_PER_STATEMENT) {
            // After one failure the rest is kept without trying: the store is likely down.
            if !failed.is_empty() {
                failed.extend_from_slice(chunk);
                continue;
            }
            if let Err(error) = store.record_ingest_rule_stats(chunk).await {
                warn!(error = %error, rows = chunk.len(), "Ingest rule stats flush failed; keeping the counts");
                failed.extend_from_slice(chunk);
            }
        }
        if let Some(dropped) = self.settle_failed(failed) {
            metrics::ingest_rule_stats_dropped(u64::try_from(dropped).unwrap_or(u64::MAX));
        }
    }

    /// Keeps the rows a flush could not write, or drops them on the `MAX_FAILED_FLUSHES`th failure
    /// in a row. Returns how many rows were dropped. An empty `failed` is a success and resets the count.
    fn settle_failed(&self, failed: Vec<IngestRuleStatRow>) -> Option<usize> {
        if failed.is_empty() {
            self.failed_flushes.store(0, Ordering::Relaxed);
            return None;
        }
        let failures = self.failed_flushes.fetch_add(1, Ordering::Relaxed) + 1;
        if failures < MAX_FAILED_FLUSHES {
            self.restore(failed);
            return None;
        }
        warn!(rows = failed.len(), failures, "Ingest rule stats dropped after repeated failed flushes");
        self.failed_flushes.store(0, Ordering::Relaxed);
        Some(failed.len())
    }
}

/// Flushes the sink every `every` until the process exits.
pub(crate) async fn run_stats_flusher(
    sink: Arc<IngestRuleStatsSink>,
    store: Arc<dyn KeyStore>,
    every: Duration,
) {
    let mut interval = tokio::time::interval(every);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick completes at once; nothing is pending yet.
    interval.tick().await;
    loop {
        interval.tick().await;
        sink.flush(store.as_ref()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn org_rules() -> OrgRules {
        let spec: IngestRuleSpec = serde_json::from_value(serde_json::json!({
            "signals": ["logs"],
            "conditions": [],
            "action": {"_tag": "redact", "keys": [], "detectors": ["email"], "patterns": [], "scopes": ["attributes"], "method": "mask"}
        }))
        .unwrap_or_else(|error| panic!("rule spec: {error}"));
        let (compiled, invalid) = CompiledRules::compile(vec![("rule_1".to_owned(), spec)], "salt".to_owned());
        assert!(invalid.is_empty());
        OrgRules::new("org_1", compiled)
    }

    fn redacted(values: u64) -> RuleStats {
        let counters = RuleCounters { matched: 1, redacted_values: values, ..RuleCounters::default() };
        RuleStats { per_rule: vec![counters.clone()], total: counters }
    }

    #[test]
    fn counts_survive_failed_flushes_until_the_limit_then_drop() {
        let sink = IngestRuleStatsSink::default();
        let rules = org_rules();
        sink.record("logs", &rules, &redacted(2), 0);
        sink.record("logs", &rules, &redacted(3), 1_000);
        for _ in 1..MAX_FAILED_FLUSHES {
            let rows = sink.take();
            assert_eq!(rows.len(), 1, "the two records share an hour and sum into one row");
            assert_eq!(rows[0].counts.redacted_values, 5);
            assert_eq!(sink.settle_failed(rows), None, "a failed flush keeps the counts");
        }
        assert_eq!(sink.settle_failed(sink.take()), Some(1), "the tenth failure in a row drops them");
        assert!(sink.take().is_empty());
        assert_eq!(sink.failed_flushes.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_successful_flush_resets_the_failure_count() {
        let sink = IngestRuleStatsSink::default();
        let rules = org_rules();
        sink.record("logs", &rules, &redacted(1), 0);
        assert_eq!(sink.settle_failed(sink.take()), None);
        assert_eq!(sink.failed_flushes.load(Ordering::Relaxed), 1);
        assert_eq!(sink.settle_failed(Vec::new()), None);
        assert_eq!(sink.failed_flushes.load(Ordering::Relaxed), 0);
    }
}
