//! The rows the encoders write, held byte for byte to the rows the gateway built
//! before them (`support/reference_rows.rs`), on random and telemetry-shaped requests,
//! whole and split into pieces of any size.

#![expect(
    clippy::unwrap_used,
    clippy::panic,
    reason = "test fixtures: an encoder that fails here has failed the test"
)]

use bytes::Bytes;
use maple_ingest::telemetry::{encode_frames, DatasourceNames, RowSource, SamplingPolicy};
use std::collections::BTreeMap;

#[path = "support/random.rs"]
mod random;
#[path = "support/reference_rows.rs"]
mod reference;
#[path = "support/shapes.rs"]
mod shapes;

use random::Rng;

/// Piece sizes from one row per piece to the whole request in one.
const PIECES: [u64; 4] = [1, 700, 64 * 1024, u64::MAX];

/// Each datasource's rows, in the order they were written.
fn by_datasource(frames: impl IntoIterator<Item = (String, Vec<u8>)>) -> BTreeMap<String, Vec<u8>> {
    let mut rows: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for (datasource, payload) in frames {
        rows.entry(datasource)
            .or_default()
            .extend_from_slice(&payload);
    }
    rows
}

fn encoded(org_id: &str, source: RowSource<'_>, piece_bytes: u64) -> BTreeMap<String, Vec<u8>> {
    let frames = encode_frames(org_id, source, piece_bytes).unwrap();
    by_datasource(
        frames
            .into_iter()
            .map(|(datasource, payload): (String, Bytes)| (datasource, payload.to_vec())),
    )
}

fn assert_same(case: &str, expected: &BTreeMap<String, Vec<u8>>, source: RowSource<'_>) {
    for piece_bytes in PIECES {
        let actual = encoded("org", source, piece_bytes);
        assert_eq!(
            actual.keys().collect::<Vec<_>>(),
            expected.keys().collect::<Vec<_>>(),
            "{case}, pieces of {piece_bytes}: datasources"
        );
        for (datasource, rows) in expected {
            if actual[datasource] != *rows {
                let (actual, rows) = (&actual[datasource], rows);
                let at = actual.iter().zip(rows).take_while(|(a, b)| a == b).count();
                let from = at.saturating_sub(80);
                panic!(
                    "{case}, pieces of {piece_bytes}, {datasource}: differs at byte {at}\n  \
                     encoded:   {}\n  reference: {}",
                    String::from_utf8_lossy(&actual[from..(at + 80).min(actual.len())]),
                    String::from_utf8_lossy(&rows[from..(at + 80).min(rows.len())]),
                );
            }
        }
    }
}

#[test]
fn random_requests_are_written_as_the_reference_writes_them() {
    let datasources = DatasourceNames::defaults();
    let mut rng = Rng(0x00c0_ffee);
    for case in 0..600 {
        let (traces, policy, mappings) = (rng.traces(), rng.policy(), rng.mappings());
        let expected = reference::encode_traces(&datasources, "org", &traces, &policy, &mappings);
        let source = RowSource::Traces {
            request: &traces,
            policy: &policy,
            mappings: &mappings,
        };
        assert_same(
            &format!("traces {case}"),
            &by_datasource(expected.unwrap()),
            source,
        );

        let logs = rng.logs();
        let expected = reference::encode_logs(&datasources, "org", &logs).unwrap();
        assert_same(
            &format!("logs {case}"),
            &by_datasource(expected),
            RowSource::Logs(&logs),
        );

        let metrics = rng.metrics();
        let expected = reference::encode_metrics(&datasources, "org", &metrics).unwrap();
        let source = RowSource::Metrics(&metrics);
        assert_same(&format!("metrics {case}"), &by_datasource(expected), source);
    }
}

#[test]
fn telemetry_shaped_requests_are_written_as_the_reference_writes_them() {
    let datasources = DatasourceNames::defaults();
    let policy = SamplingPolicy::default();
    let traces = shapes::traces(400);
    let expected = reference::encode_traces(&datasources, "org", &traces, &policy, &[]).unwrap();
    let source = RowSource::Traces {
        request: &traces,
        policy: &policy,
        mappings: &[],
    };
    assert_same("traces", &by_datasource(expected), source);

    let logs = shapes::logs(400);
    let expected = reference::encode_logs(&datasources, "org", &logs).unwrap();
    assert_same("logs", &by_datasource(expected), RowSource::Logs(&logs));

    for (name, metrics) in [
        ("metrics", shapes::metrics(800)),
        (
            "jvm metrics",
            shapes::metrics_from(shapes::jvm_resource(), 800),
        ),
    ] {
        let expected = reference::encode_metrics(&datasources, "org", &metrics).unwrap();
        assert_same(name, &by_datasource(expected), RowSource::Metrics(&metrics));
    }
}
