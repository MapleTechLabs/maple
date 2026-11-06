//! Latency of concurrent small appends to one WAL lane behind a slow fsync.
//!
//! `cargo bench --bench wal_append_bench`. The fsync is injected (a sleep), so
//! the numbers model a device with that sync latency, not the disk under test.
//! `WAL_BENCH_FSYNC_US` (default `200,2000`) and `WAL_BENCH_APPENDS` (default
//! 10000 per scenario) tune it.
#![expect(
    clippy::expect_used,
    reason = "a benchmark that cannot open its lane has nothing to measure"
)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use maple_ingest::telemetry::{WalLaneBench, WalSync};

const PAYLOAD_BYTES: usize = 1024;
const SEGMENT_MAX_BYTES: u64 = 8 * 1024 * 1024;

struct Scenario {
    name: &'static str,
    writers: usize,
    /// Offered load as a fraction of one-fsync-per-append capacity; `None` is a
    /// closed loop with no think time.
    utilization: Option<f64>,
}

const SCENARIOS: [Scenario; 3] = [
    Scenario {
        name: "open 64w @0.8",
        writers: 64,
        utilization: Some(0.8),
    },
    Scenario {
        name: "open 64w @1.2",
        writers: 64,
        utilization: Some(1.2),
    },
    Scenario {
        name: "closed 32w",
        writers: 32,
        utilization: None,
    },
];

fn env_list(name: &str, default: &str) -> Vec<u64> {
    std::env::var(name)
        .unwrap_or_else(|_| default.to_owned())
        .split(',')
        .filter_map(|value| value.trim().parse().ok())
        .collect()
}

/// xorshift64*, so think times are exponential without a rand dependency.
fn next_unit(state: &mut u64) -> f64 {
    *state ^= *state >> 12;
    *state ^= *state << 25;
    *state ^= *state >> 27;
    let bits = state.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11;
    #[expect(
        clippy::cast_precision_loss,
        reason = "53 random bits map exactly onto an f64 mantissa"
    )]
    let unit = bits as f64 / (1u64 << 53) as f64;
    unit
}

fn percentile(sorted: &[Duration], q: f64) -> f64 {
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "an index into a sample vector"
    )]
    let index = ((sorted.len() as f64 - 1.0) * q).round() as usize;
    sorted[index].as_secs_f64() * 1000.0
}

fn run(fsync_us: u64, scenario: &Scenario, appends: usize) {
    let dir = std::env::temp_dir().join(format!(
        "maple-wal-bench-{}-{fsync_us}-{}",
        std::process::id(),
        scenario.writers
    ));
    drop(std::fs::remove_dir_all(&dir));
    let fsyncs = Arc::new(AtomicU64::new(0));
    let fsync_nanos = Arc::new(AtomicU64::new(0));
    let delay = Duration::from_micros(fsync_us);
    let sync: WalSync = {
        let fsyncs = Arc::clone(&fsyncs);
        let fsync_nanos = Arc::clone(&fsync_nanos);
        Arc::new(move |_file| {
            let started = Instant::now();
            thread::sleep(delay);
            fsyncs.fetch_add(1, Ordering::Relaxed);
            #[expect(
                clippy::cast_possible_truncation,
                reason = "one sleep is far under 584 years"
            )]
            fsync_nanos.fetch_add(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
            Ok(())
        })
    };
    let lane = Arc::new(WalLaneBench::open(&dir, SEGMENT_MAX_BYTES, sync).expect("open lane"));
    let per_writer = appends / scenario.writers;
    #[expect(clippy::cast_precision_loss, reason = "writer counts are tiny")]
    let mean_think = scenario
        .utilization
        .map(|u| delay.as_secs_f64() * scenario.writers as f64 / u);

    let started = Instant::now();
    let handles: Vec<_> = (0..scenario.writers)
        .map(|writer| {
            let lane = Arc::clone(&lane);
            thread::spawn(move || {
                let mut rng = 0x9E37_79B9_7F4A_7C15_u64 ^ (writer as u64 + 1);
                let mut latencies = Vec::with_capacity(per_writer);
                for _ in 0..per_writer {
                    if let Some(mean) = mean_think {
                        let think = -mean * (1.0 - next_unit(&mut rng)).ln();
                        thread::sleep(Duration::from_secs_f64(think));
                    }
                    let append_started = Instant::now();
                    lane.append(vec![7u8; PAYLOAD_BYTES]).expect("append");
                    latencies.push(append_started.elapsed());
                }
                latencies
            })
        })
        .collect();
    let mut latencies: Vec<Duration> = handles
        .into_iter()
        .flat_map(|handle| handle.join().expect("writer thread"))
        .collect();
    let elapsed = started.elapsed();
    latencies.sort_unstable();
    drop(std::fs::remove_dir_all(&dir));

    let syncs = fsyncs.load(Ordering::Relaxed);
    #[expect(clippy::cast_precision_loss, reason = "sample counts are small")]
    let (per_append, sync_ms, throughput) = (
        syncs as f64 / latencies.len() as f64,
        fsync_nanos.load(Ordering::Relaxed) as f64 / syncs.max(1) as f64 / 1e6,
        latencies.len() as f64 / elapsed.as_secs_f64(),
    );
    println!(
        "| {fsync_us:>5} us | {:<14} | {:>6} | {:>8.2} | {:>8.2} | {:>8.2} | {:>8.2} | {per_append:>5.3} | {sync_ms:>6.3} | {throughput:>7.0} |",
        scenario.name,
        latencies.len(),
        percentile(&latencies, 0.5),
        percentile(&latencies, 0.99),
        percentile(&latencies, 0.999),
        percentile(&latencies, 1.0),
    );
}

fn main() {
    let appends = env_list("WAL_BENCH_APPENDS", "10000")
        .first()
        .copied()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(10_000);
    println!(
        "| fsync    | scenario       | n      | p50 ms   | p99 ms   | p99.9 ms | max ms   | fsync/append | fsync ms | appends/s |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|");
    for fsync_us in env_list("WAL_BENCH_FSYNC_US", "200,2000") {
        for scenario in &SCENARIOS {
            run(fsync_us, scenario, appends);
        }
    }
}
