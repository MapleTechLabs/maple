//! Embedded chDB (in-process ClickHouse) for the standalone `maple` binary.
//!
//! chDB is embedded — exactly one OS thread may own the data directory — so all
//! access (bootstrap, inserts, queries) is funneled through a single dedicated
//! writer thread. Async callers hand work to it over a channel and await a
//! oneshot reply.
//!
//! The schema and the OTLP→column insert mappings are embedded at compile time
//! from the artifacts the TS codegen produces (`clickhouse:schema`), so the
//! local path uses the exact same ClickHouse schema as the cloud deployment.

use std::collections::HashMap;
use std::path::PathBuf;

use chdb_rust::arg::Arg;
use chdb_rust::format::OutputFormat;
use chdb_rust::session::{Session, SessionBuilder};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};

/// Full DDL (base tables + materialized views), `IF NOT EXISTS`, generated from
/// `latestSnapshotStatements`. Applied once at startup via `Arg::MultiQuery`.
const SCHEMA_SQL: &str = include_str!("../schema/local-schema.sql");

/// OTLP-datasource → column/select/input-schema mappings, generated from the
/// Tinybird manifest so the snake_case NDJSON the encoders emit maps to the
/// PascalCase table columns with zero divergence.
const INSERT_MAPPINGS_JSON: &str = include_str!("../schema/local-inserts.json");

#[derive(Deserialize)]
struct InsertMappingsFile {
    #[serde(rename = "orgPlaceholder")]
    org_placeholder: String,
    datasources: HashMap<String, DatasourceMapping>,
}

#[derive(Deserialize)]
struct DatasourceMapping {
    table: String,
    columns: Vec<String>,
    selects: Vec<String>,
    #[serde(rename = "inputSchema")]
    input_schema: String,
}

/// Per-datasource INSERT template, split around the NDJSON string literal:
/// `INSERT INTO <t> (<cols>) SELECT <selects> FROM format(JSONEachRow, '<schema>', '<DATA>')`.
struct InsertTemplate {
    prefix: String,
    suffix: String,
}

struct Templates {
    by_datasource: HashMap<String, InsertTemplate>,
}

impl Templates {
    fn build(org_literal: &str) -> Result<Self, String> {
        let file: InsertMappingsFile = serde_json::from_str(INSERT_MAPPINGS_JSON)
            .map_err(|error| format!("parse local-inserts.json: {error}"))?;
        let org_escaped = escape_sql_literal(org_literal);

        let mut by_datasource = HashMap::with_capacity(file.datasources.len());
        for (name, mapping) in file.datasources {
            // Pin OrgId to the local tenant; every other select references a
            // column produced by the format() table function.
            let selects: Vec<String> = mapping
                .selects
                .iter()
                .map(|select| {
                    if select == &file.org_placeholder {
                        format!("'{org_escaped}'")
                    } else {
                        select.clone()
                    }
                })
                .collect();

            let prefix = format!(
                "INSERT INTO {table} ({columns}) SELECT {selects} FROM format(JSONEachRow, '{schema}', '",
                table = mapping.table,
                columns = mapping.columns.join(", "),
                selects = selects.join(", "),
                schema = mapping.input_schema,
            );
            by_datasource.insert(name, InsertTemplate { prefix, suffix: "')".to_string() });
        }

        Ok(Self { by_datasource })
    }
}

enum Command {
    Insert { datasource: String, ndjson: Vec<u8>, reply: oneshot::Sender<Result<(), String>> },
    Query { sql: String, reply: oneshot::Sender<Result<Vec<u8>, String>> },
}

/// Handle to the single chDB writer thread. Cheap to clone (shares the channel).
#[derive(Clone)]
pub struct Chdb {
    tx: mpsc::UnboundedSender<Command>,
}

impl Chdb {
    /// Open (or reopen) the chDB data directory, bootstrap the schema, and spawn
    /// the writer thread. Blocks until bootstrap finishes so a failure surfaces
    /// before the server starts accepting traffic. `org_literal` is the pinned
    /// single-tenant OrgId (e.g. `"local"`).
    pub fn start(data_dir: PathBuf, org_literal: &str) -> Result<Self, String> {
        let templates = Templates::build(org_literal)?;
        let (tx, mut rx) = mpsc::unbounded_channel::<Command>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

        std::thread::Builder::new()
            .name("chdb-writer".to_string())
            .spawn(move || {
                let session = match SessionBuilder::new().with_data_path(data_dir).build() {
                    Ok(session) => session,
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("open chDB session: {error}")));
                        return;
                    }
                };

                // Idempotent (`IF NOT EXISTS`); MultiQuery so the ClickHouse
                // parser splits statements correctly (a naive `;` split breaks
                // on semicolons inside `--` comments).
                if let Err(error) = session.execute(SCHEMA_SQL, Some(&[Arg::MultiQuery])) {
                    let _ = ready_tx.send(Err(format!("bootstrap chDB schema: {error}")));
                    return;
                }
                let _ = ready_tx.send(Ok(()));

                while let Some(command) = rx.blocking_recv() {
                    match command {
                        Command::Insert { datasource, ndjson, reply } => {
                            let _ = reply.send(insert_rows(&session, &templates, &datasource, &ndjson));
                        }
                        Command::Query { sql, reply } => {
                            let _ = reply.send(run_query(&session, &sql));
                        }
                    }
                }
            })
            .map_err(|error| format!("spawn chDB writer thread: {error}"))?;

        ready_rx
            .recv()
            .map_err(|_| "chDB writer thread exited during init".to_string())??;

        Ok(Self { tx })
    }

    /// Insert one datasource's NDJSON batch. `datasource` must be a key present
    /// in the embedded insert mappings (e.g. `"traces"`, `"logs"`).
    pub async fn insert(&self, datasource: String, ndjson: Vec<u8>) -> Result<(), String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::Insert { datasource, ndjson, reply })
            .map_err(|_| "chDB writer thread is gone".to_string())?;
        rx.await.map_err(|_| "chDB writer dropped insert reply".to_string())?
    }

    /// Run a read query and return its rows as JSONEachRow bytes (one JSON
    /// object per line; empty when there are no rows).
    pub async fn query(&self, sql: String) -> Result<Vec<u8>, String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Command::Query { sql, reply })
            .map_err(|_| "chDB writer thread is gone".to_string())?;
        rx.await.map_err(|_| "chDB writer dropped query reply".to_string())?
    }
}

fn insert_rows(
    session: &Session,
    templates: &Templates,
    datasource: &str,
    ndjson: &[u8],
) -> Result<(), String> {
    let template = templates
        .by_datasource
        .get(datasource)
        .ok_or_else(|| format!("no insert mapping for datasource '{datasource}'"))?;

    let data = String::from_utf8_lossy(ndjson);
    let escaped = data.replace('\\', "\\\\").replace('\'', "\\'");
    let sql = format!("{}{}{}", template.prefix, escaped, template.suffix);

    session
        .execute(&sql, None)
        .map_err(|error| format!("chDB insert into '{datasource}': {error}"))?;
    Ok(())
}

fn run_query(session: &Session, sql: &str) -> Result<Vec<u8>, String> {
    let result = session
        .execute(sql, Some(&[Arg::OutputFormat(OutputFormat::JSONEachRow)]))
        .map_err(|error| format!("chDB query: {error}"))?;
    Ok(result.data_utf8_lossy().as_bytes().to_vec())
}

/// Escape a value for a single-quoted ClickHouse SQL string literal.
fn escape_sql_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}
