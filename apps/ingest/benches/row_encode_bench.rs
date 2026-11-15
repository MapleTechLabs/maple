//! CPU cost of turning a decoded OTLP batch into the rows the WAL stores: the
//! row estimate and the encoding it sizes, the stage between decoding and the WAL
//! append, with no disk or network in it.
#![expect(
    clippy::expect_used,
    reason = "a benchmark that cannot encode its fixtures has nothing to measure"
)]

use criterion::{black_box, criterion_group, criterion_main, Criterion, Throughput};
use maple_ingest::row_budget::{log_rows, metric_rows, trace_rows, ROW_PIECE_BYTES};
use maple_ingest::telemetry::{
    encode_frames, encode_log_rows, encode_metric_rows, encode_trace_rows, RowSource,
    SamplingPolicy,
};
use prost::Message;

#[path = "../tests/support/shapes.rs"]
mod shapes;

fn bench_row_encode(c: &mut Criterion) {
    let traces = shapes::traces(2_000);
    let logs = shapes::logs(2_000);
    let metrics = shapes::metrics(4_000);
    let policy = SamplingPolicy::default();

    let mut group = c.benchmark_group("row_encode");
    group.throughput(Throughput::Bytes(traces.encoded_len() as u64));
    group.bench_function("traces_2000_spans", |b| {
        b.iter(|| {
            black_box(
                encode_trace_rows("org_bench", black_box(&traces), &policy, &[])
                    .expect("encode traces"),
            )
        });
    });
    group.throughput(Throughput::Bytes(logs.encoded_len() as u64));
    group.bench_function("logs_2000_records", |b| {
        b.iter(|| black_box(encode_log_rows(black_box(&logs)).expect("encode logs")));
    });
    group.throughput(Throughput::Bytes(metrics.encoded_len() as u64));
    group.bench_function("metrics_4000_points", |b| {
        b.iter(|| black_box(encode_metric_rows(black_box(&metrics)).expect("encode metrics")));
    });
    group.finish();

    // The estimate alone: the pass a request pays before its rows are built.
    let mut group = c.benchmark_group("row_estimate");
    group.throughput(Throughput::Bytes(traces.encoded_len() as u64));
    group.bench_function("traces_2000_spans", |b| {
        b.iter(|| black_box(trace_rows("org_bench", black_box(&traces), &policy, &[])));
    });
    group.throughput(Throughput::Bytes(logs.encoded_len() as u64));
    group.bench_function("logs_2000_records", |b| {
        b.iter(|| black_box(log_rows(black_box(&logs))));
    });
    group.throughput(Throughput::Bytes(metrics.encoded_len() as u64));
    group.bench_function("metrics_4000_points", |b| {
        b.iter(|| black_box(metric_rows(black_box(&metrics))));
    });
    group.finish();

    // A JVM service's batch, whose rows are many pieces: built in pieces, as the
    // gateway does, against the same rows built whole.
    let jvm = shapes::metrics_from(shapes::jvm_resource(), 20_000);
    let mut group = c.benchmark_group("row_encode_pieces");
    group.sample_size(20);
    group.throughput(Throughput::Bytes(jvm.encoded_len() as u64));
    for (name, piece_bytes) in [
        ("jvm_metrics_in_pieces", ROW_PIECE_BYTES),
        ("jvm_metrics_whole", u64::MAX),
    ] {
        group.bench_function(name, |b| {
            b.iter(|| {
                black_box(
                    encode_frames(
                        "org_bench",
                        RowSource::Metrics(black_box(&jvm)),
                        piece_bytes,
                    )
                    .expect("encode metrics"),
                )
            });
        });
    }
    group.finish();
}

criterion_group!(benches, bench_row_encode);
criterion_main!(benches);
