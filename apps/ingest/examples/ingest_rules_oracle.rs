//! One fixture-shaped case per stdin line in, one outcome per stdout line out. The TS
//! differential fuzzer (`packages/ingest-rules/scripts/fuzz.ts`) keeps this process open and
//! compares every outcome with the TS engine's.

use std::io::{self, BufRead, Write};

use maple_ingest::ingest_rules::conformance::{run_case, Case};
use serde_json::json;

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line?;
        let outcome = match serde_json::from_str::<Case>(&line) {
            Ok(case) => run_case(&case),
            Err(error) => json!({ "decodeError": error.to_string() }),
        };
        writeln!(out, "{outcome}")?;
        out.flush()?;
    }
    Ok(())
}
