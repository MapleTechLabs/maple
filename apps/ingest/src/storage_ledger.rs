//! The bytes each org stores, per billed signal, UTC day and retention stamp, flushed to
//! `ingest_storage_ledger`. The API bills storage from it once a day: the sum of the days
//! still inside their stamp. Recorded next to the Autumn ingest track, from the same bytes.
//!
//! The day is when Maple received the bytes, not their event time, which the warehouse expires
//! by. Storage is billed from that day for the period stamped then, and never past
//! `day + retention_days` (`storage-metering.ts`).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use tracing::{error, warn};

use crate::KeyStore;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Rows per `INSERT`: 5 parameters each, far below Postgres' 65535 limit.
const LEDGER_ROWS_PER_STATEMENT: usize = 1000;
/// Consecutive failed flushes after which the pending bytes are given up.
const MAX_FAILED_FLUSHES: u32 = 30;

/// One `ingest_storage_ledger` row's worth of bytes to add.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StorageLedgerRow {
    pub(crate) org_id: String,
    /// The Autumn ingest feature id the bytes were billed under.
    pub(crate) signal: &'static str,
    /// Start of the UTC day, in epoch milliseconds.
    pub(crate) day_ms: i64,
    pub(crate) retention_days: u16,
    pub(crate) bytes: u64,
}

/// (org, signal, UTC day in epoch ms, retention stamp).
type LedgerKey = (Arc<str>, &'static str, i64, u16);

/// Bytes summed per ledger key until the next flush. Sharded, so concurrent requests rarely contend.
#[derive(Default)]
pub(crate) struct StorageLedgerSink {
    pending: DashMap<LedgerKey, u64>,
    failed_flushes: AtomicU32,
}

impl StorageLedgerSink {
    /// Adds `bytes` stored for `retention_days`; free when nothing was stored.
    pub(crate) fn record(
        &self,
        org_id: &str,
        signal: &'static str,
        retention_days: u16,
        bytes: u64,
        now_ms: i64,
    ) {
        if bytes == 0 {
            return;
        }
        let day_ms = now_ms - now_ms.rem_euclid(DAY_MS);
        let key = (Arc::from(org_id), signal, day_ms, retention_days);
        *self.pending.entry(key).or_default() += bytes;
    }

    /// Splits `bytes` over the stamps in `shares` by item count, then records each part.
    /// The remainder of the integer split goes to the longest stamp, so no byte is lost.
    pub(crate) fn record_split(
        &self,
        org_id: &str,
        signal: &'static str,
        shares: &[(u16, usize)],
        bytes: u64,
        now_ms: i64,
    ) {
        for (retention_days, part) in split_bytes(shares, bytes) {
            self.record(org_id, signal, retention_days, part, now_ms);
        }
    }

    /// Removes and returns every pending row; bytes added meanwhile wait for the next flush.
    fn take(&self) -> Vec<StorageLedgerRow> {
        let keys: Vec<LedgerKey> = self.pending.iter().map(|entry| entry.key().clone()).collect();
        keys.into_iter()
            .filter_map(|key| self.pending.remove(&key))
            .map(|((org_id, signal, day_ms, retention_days), bytes)| StorageLedgerRow {
                org_id: org_id.to_string(),
                signal,
                day_ms,
                retention_days,
                bytes,
            })
            .collect()
    }

    fn restore(&self, rows: Vec<StorageLedgerRow>) {
        for row in rows {
            let key = (Arc::from(row.org_id), row.signal, row.day_ms, row.retention_days);
            *self.pending.entry(key).or_default() += row.bytes;
        }
    }

    /// Writes the pending bytes. A failure keeps them for the next flush, up to
    /// `MAX_FAILED_FLUSHES` in a row, after which they are dropped and logged.
    pub(crate) async fn flush(&self, store: &dyn KeyStore) {
        let rows = self.take();
        if rows.is_empty() {
            return;
        }
        let mut failed: Vec<StorageLedgerRow> = Vec::new();
        for chunk in rows.chunks(LEDGER_ROWS_PER_STATEMENT) {
            // After one failure the rest is kept without trying: the store is likely down.
            if !failed.is_empty() {
                failed.extend_from_slice(chunk);
                continue;
            }
            if let Err(error) = store.record_storage_ledger(chunk).await {
                warn!(error = %error, rows = chunk.len(), "Storage ledger flush failed; keeping the bytes");
                failed.extend_from_slice(chunk);
            }
        }
        self.settle_failed(failed);
    }

    /// The flush at shutdown: the sink is dropped right after, so rows that fail are logged
    /// one per line at error level, for adding by hand, instead of being kept.
    pub(crate) async fn flush_final(&self, store: &dyn KeyStore) {
        let rows = self.take();
        for chunk in rows.chunks(LEDGER_ROWS_PER_STATEMENT) {
            if let Err(flush_error) = store.record_storage_ledger(chunk).await {
                error!(
                    error = %flush_error,
                    rows = chunk.len(),
                    "Storage ledger final flush failed; the bytes are lost"
                );
                for row in chunk {
                    error!(
                        org_id = %row.org_id,
                        signal = row.signal,
                        day_ms = row.day_ms,
                        retention_days = row.retention_days,
                        bytes = row.bytes,
                        "Storage ledger bytes lost at shutdown"
                    );
                }
            }
        }
    }

    /// Keeps the rows a flush could not write, or drops them on the `MAX_FAILED_FLUSHES`th
    /// failure in a row. Returns how many rows were dropped.
    fn settle_failed(&self, failed: Vec<StorageLedgerRow>) -> Option<usize> {
        if failed.is_empty() {
            self.failed_flushes.store(0, Ordering::Relaxed);
            return None;
        }
        let failures = self.failed_flushes.fetch_add(1, Ordering::Relaxed) + 1;
        if failures < MAX_FAILED_FLUSHES {
            self.restore(failed);
            return None;
        }
        // One line per row, so the bytes can be added by hand.
        for row in &failed {
            warn!(
                org_id = %row.org_id,
                signal = row.signal,
                day_ms = row.day_ms,
                retention_days = row.retention_days,
                bytes = row.bytes,
                "Storage ledger bytes dropped after repeated failed flushes"
            );
        }
        self.failed_flushes.store(0, Ordering::Relaxed);
        Some(failed.len())
    }
}

/// `bytes` split over `shares` by item count, one part per distinct stamp.
fn split_bytes(shares: &[(u16, usize)], bytes: u64) -> Vec<(u16, u64)> {
    let mut by_stamp: Vec<(u16, u64)> = Vec::new();
    for &(stamp, items) in shares {
        let items = u64::try_from(items).unwrap_or(u64::MAX);
        match by_stamp.iter_mut().find(|(seen, _)| *seen == stamp) {
            Some((_, total)) => *total = total.saturating_add(items),
            None => by_stamp.push((stamp, items)),
        }
    }
    by_stamp.sort_unstable_by_key(|(stamp, _)| *stamp);
    let total_items: u64 = by_stamp.iter().map(|(_, items)| *items).sum();
    let Some(&(longest, _)) = by_stamp.last() else {
        return Vec::new();
    };
    if total_items == 0 || by_stamp.len() == 1 {
        return vec![(longest, bytes)];
    }
    let mut parts: Vec<(u16, u64)> = by_stamp
        .iter()
        .map(|&(stamp, items)| {
            let part = u128::from(bytes) * u128::from(items) / u128::from(total_items);
            (stamp, u64::try_from(part).unwrap_or(u64::MAX))
        })
        .collect();
    let assigned: u64 = parts.iter().map(|(_, part)| *part).sum();
    if let Some(last) = parts.last_mut() {
        last.1 += bytes.saturating_sub(assigned);
    }
    parts
}

/// The upsert that adds `rows` ledger rows' bytes, 5 parameters each:
/// org id, signal, day (epoch ms), retention days, bytes.
pub(crate) fn storage_ledger_upsert_sql(rows: usize) -> String {
    let mut sql = String::from(
        "INSERT INTO ingest_storage_ledger (org_id, signal, day, retention_days, bytes) VALUES ",
    );
    for row in 0..rows {
        let p = row * 5;
        if row > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!(
            "(${}, ${}, to_timestamp(${}::bigint / 1000.0), ${}::int4, ${}::bigint)",
            p + 1,
            p + 2,
            p + 3,
            p + 4,
            p + 5
        ));
    }
    sql.push_str(
        " ON CONFLICT (org_id, signal, day, retention_days) DO UPDATE SET \
         bytes = ingest_storage_ledger.bytes + EXCLUDED.bytes",
    );
    sql
}

/// Flushes the sink every `every` until the process exits.
pub(crate) async fn run_ledger_flusher(
    sink: Arc<StorageLedgerSink>,
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

    const NOON_MS: i64 = 1_764_072_000_000; // 2025-11-25T12:00:00Z
    const MIDNIGHT_MS: i64 = 1_764_028_800_000; // 2025-11-25T00:00:00Z

    fn sorted(mut rows: Vec<StorageLedgerRow>) -> Vec<StorageLedgerRow> {
        rows.sort_by_key(|row| (row.org_id.clone(), row.signal, row.day_ms, row.retention_days));
        rows
    }

    #[test]
    fn bytes_sum_per_org_signal_day_and_stamp() {
        let sink = StorageLedgerSink::default();
        sink.record("org_a", "logs", 30, 100, NOON_MS);
        sink.record("org_a", "logs", 30, 50, MIDNIGHT_MS + 1);
        sink.record("org_a", "logs", 90, 7, NOON_MS);
        sink.record("org_a", "traces", 30, 9, NOON_MS);
        sink.record("org_b", "logs", 30, 1, NOON_MS + DAY_MS);
        sink.record("org_b", "logs", 30, 0, NOON_MS);

        let rows = sorted(sink.take());
        let row = |org: &str, signal, day_ms, retention_days, bytes| StorageLedgerRow {
            org_id: org.to_owned(),
            signal,
            day_ms,
            retention_days,
            bytes,
        };
        assert_eq!(
            rows,
            vec![
                row("org_a", "logs", MIDNIGHT_MS, 30, 150),
                row("org_a", "logs", MIDNIGHT_MS, 90, 7),
                row("org_a", "traces", MIDNIGHT_MS, 30, 9),
                row("org_b", "logs", MIDNIGHT_MS + DAY_MS, 30, 1),
            ]
        );
        assert!(sink.take().is_empty());
    }

    #[test]
    fn a_split_keeps_every_byte_and_follows_item_share() {
        assert_eq!(split_bytes(&[(30, 3), (90, 1)], 1000), vec![(30, 750), (90, 250)]);
        // The integer remainder goes to the longest stamp.
        assert_eq!(split_bytes(&[(30, 1), (90, 1), (7, 1)], 10), vec![(7, 3), (30, 3), (90, 4)]);
        // Resources of one stamp named twice count once.
        assert_eq!(split_bytes(&[(30, 2), (30, 2)], 10), vec![(30, 10)]);
        // No items to weigh by: everything is kept for the longest stamp.
        assert_eq!(split_bytes(&[(30, 0), (90, 0)], 10), vec![(90, 10)]);
        assert!(split_bytes(&[], 10).is_empty());
    }

    #[test]
    fn failed_rows_are_kept_until_the_limit_then_dropped() {
        let sink = StorageLedgerSink::default();
        let row = StorageLedgerRow {
            org_id: "org_a".to_owned(),
            signal: "logs",
            day_ms: MIDNIGHT_MS,
            retention_days: 30,
            bytes: 10,
        };
        for _ in 1..MAX_FAILED_FLUSHES {
            assert_eq!(sink.settle_failed(vec![row.clone()]), None);
            assert_eq!(sink.take(), vec![row.clone()]);
        }
        assert_eq!(sink.settle_failed(vec![row.clone()]), Some(1));
        assert!(sink.take().is_empty());
    }

    #[test]
    fn restored_rows_add_to_bytes_recorded_meanwhile() {
        let sink = StorageLedgerSink::default();
        sink.record("org_a", "logs", 30, 10, NOON_MS);
        let taken = sink.take();
        sink.record("org_a", "logs", 30, 5, NOON_MS);
        sink.restore(taken);
        assert_eq!(sink.take()[0].bytes, 15);
    }

    #[test]
    fn the_upsert_numbers_five_parameters_per_row_and_adds_bytes() {
        let sql = storage_ledger_upsert_sql(2);
        assert!(sql.contains("($1, $2, to_timestamp($3::bigint / 1000.0), $4::int4, $5::bigint), ($6, $7,"));
        assert!(sql.ends_with("bytes = ingest_storage_ledger.bytes + EXCLUDED.bytes"));
    }
}
