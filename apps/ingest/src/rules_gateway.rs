//! Customer ingest rules in the gateway: each org's compiled rules, cached, and
//! the per-rule counts flushed to `org_ingest_rule_stats`. The engine itself is
//! `maple_ingest::ingest_rules`; the contract is `docs/ingest-rules.md`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
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

/// Each org's compiled rules: cached for a TTL, the last good load served when the store fails.
pub(crate) struct IngestRuleResolver {
    store: Arc<dyn KeyStore>,
    /// `INGEST_RULES_ENABLED`; when false the store is never queried.
    enabled: bool,
    cache: Cache<String, Arc<CompiledRules>>,
    last_known: DashMap<String, Arc<CompiledRules>>,
    empty: Arc<CompiledRules>,
}

impl IngestRuleResolver {
    pub(crate) fn new(store: Arc<dyn KeyStore>, enabled: bool, ttl: Duration, capacity: u64) -> Self {
        Self {
            store,
            enabled,
            cache: Cache::builder()
                .time_to_live(ttl)
                .max_capacity(capacity)
                .build(),
            last_known: DashMap::new(),
            empty: Arc::new(CompiledRules::default()),
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    /// The org's rules. A failed lookup serves the last good load (or none) until the TTL ends.
    pub(crate) async fn resolve_rules(&self, org_id: &str) -> Arc<CompiledRules> {
        if !self.enabled {
            return Arc::clone(&self.empty);
        }
        if let Some(rules) = self.cache.get(org_id).await {
            return rules;
        }
        let rules = match self.store.fetch_ingest_rules(org_id).await {
            Ok(rows) => {
                let rules = Arc::new(compile_rows(org_id, rows));
                self.last_known
                    .insert(org_id.to_owned(), Arc::clone(&rules));
                rules
            }
            Err(error) => {
                metrics::ingest_rules_fetch_failed(org_id);
                if let Some(stale) = self.last_known.get(org_id) {
                    warn!(org_id, error = %error, "Ingest rule lookup failed; serving last-known rules");
                    Arc::clone(stale.value())
                } else {
                    warn!(org_id, error = %error, "Ingest rule lookup failed with no last-known rules");
                    Arc::clone(&self.empty)
                }
            }
        };
        self.cache
            .insert(org_id.to_owned(), Arc::clone(&rules))
            .await;
        rules
    }

    /// Ends the cached entry early, so the next request reloads.
    #[cfg(test)]
    pub(crate) async fn expire(&self, org_id: &str) {
        self.cache.invalidate(org_id).await;
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
    let skipped = unparsable + u64::try_from(invalid.len()).unwrap_or(u64::MAX);
    if skipped > 0 {
        metrics::ingest_rules_invalid(org_id, skipped);
    }
    compiled
}

type StatKey = (String, String, i64, &'static str);

/// Per-rule counts summed per (org, rule, UTC hour, signal) until the next flush.
#[derive(Default)]
pub(crate) struct IngestRuleStatsSink {
    pending: Mutex<HashMap<StatKey, RuleCounters>>,
    failed_flushes: AtomicU32,
}

fn add_counts(total: &mut RuleCounters, more: &RuleCounters) {
    total.matched += more.matched;
    total.dropped += more.dropped;
    total.dropped_bytes += more.dropped_bytes;
    total.redacted_values += more.redacted_values;
}

impl IngestRuleStatsSink {
    fn lock(&self) -> MutexGuard<'_, HashMap<StatKey, RuleCounters>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Adds one payload's counts; free when no rule matched.
    pub(crate) fn record(
        &self,
        org_id: &str,
        signal: &'static str,
        rules: &CompiledRules,
        stats: &RuleStats,
        now_ms: i64,
    ) {
        if stats.total.matched == 0 {
            return;
        }
        let bucket_ms = now_ms - now_ms.rem_euclid(HOUR_MS);
        let mut pending = self.lock();
        for (rule_id, counters) in rules.rule_ids().iter().zip(&stats.per_rule) {
            if counters.matched == 0 {
                continue;
            }
            let key = (org_id.to_owned(), rule_id.clone(), bucket_ms, signal);
            add_counts(pending.entry(key).or_default(), counters);
        }
    }

    fn take(&self) -> Vec<IngestRuleStatRow> {
        std::mem::take(&mut *self.lock())
            .into_iter()
            .map(|((org_id, rule_id, bucket_ms, signal), counts)| IngestRuleStatRow {
                org_id,
                rule_id,
                bucket_ms,
                signal,
                counts,
            })
            .collect()
    }

    fn restore(&self, rows: Vec<IngestRuleStatRow>) {
        let mut pending = self.lock();
        for row in rows {
            let key = (row.org_id, row.rule_id, row.bucket_ms, row.signal);
            add_counts(pending.entry(key).or_default(), &row.counts);
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
        if failed.is_empty() {
            self.failed_flushes.store(0, Ordering::Relaxed);
            return;
        }
        let failures = self.failed_flushes.fetch_add(1, Ordering::Relaxed) + 1;
        if failures >= MAX_FAILED_FLUSHES {
            warn!(rows = failed.len(), failures, "Ingest rule stats dropped after repeated failed flushes");
            metrics::ingest_rule_stats_dropped(u64::try_from(failed.len()).unwrap_or(u64::MAX));
            self.failed_flushes.store(0, Ordering::Relaxed);
        } else {
            self.restore(failed);
        }
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
