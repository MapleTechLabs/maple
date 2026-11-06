import type { QueryResultContract } from "@maple/query-model"
import { Array as Arr, Record as Rec } from "effect"

/**
 * The legacy endpoint vocabulary — NOT schema.
 *
 * Before v3 a data source was `{ endpoint, params }`, and the endpoint string
 * carried the source's identity: `"custom_query_builder_timeseries"` meant "a
 * query set returning a timeseries", `"raw_sql_chart"` meant raw SQL. v3 makes
 * that identity structural (`kind` + `resultShape`), so the strings stop being
 * schema.
 *
 * They do not stop existing. Requests are still keyed by them: `toWidgetRequest`
 * lowers a v3 source to an endpoint, and the web app's server-function registry
 * (`data-source-registry.ts`) uses that string as its atom family key, retention
 * namespace and `LIST_ENDPOINTS` test. The public v2 API speaks v3 (`kind`), and
 * `access.ts` still reads a v2 `{ endpoint, params }` bag wherever one survives.
 *
 * They live in their own file, away from the schema modules, so that this
 * distinction survives contact with the next refactor: these are wire
 * vocabularies that happen to be strings, not a resultKind anything is stored in.
 */

/**
 * The endpoints that carried a user-authored query set, keyed by the result
 * resultKind that is their v3 identity.
 *
 * Canonical in this direction because request lowering writes it and the MCP
 * inspector reports it; the endpoint -> resultKind lookup is derived below, so the
 * two cannot drift.
 */
export const QUERY_RESULT_ENDPOINTS = {
	timeseries: "custom_query_builder_timeseries",
	breakdown: "custom_query_builder_breakdown",
	list: "custom_query_builder_list",
} as const satisfies Record<QueryResultContract, string>

export const QUERY_ENDPOINT_RESULT_KINDS = Rec.fromEntries(
	Arr.map(Rec.toEntries(QUERY_RESULT_ENDPOINTS), ([resultKind, endpoint]) => [endpoint, resultKind]),
)

export const RAW_SQL_ENDPOINT = "raw_sql_chart"

/**
 * The one route that never had a query: a markdown note.
 *
 * It was a `route` in v2 with a no-op server function behind it, and becomes
 * `{ kind: "static" }` in v3. Named here rather than inlined because three
 * separate places have to agree on the mapping (the migration, the v2 API
 * encoder, and the web registry that stops needing a server function for it).
 */
export const MARKDOWN_STATIC_ENDPOINT = "markdown_static"
