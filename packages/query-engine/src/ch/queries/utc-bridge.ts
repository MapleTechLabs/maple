// Type-only bridges for queries that mix a rollup time column (read as a
// `DateTime.Utc`) with a raw table whose time columns still decode as strings.
// Neither changes the SQL. Delete each one once the raw table it touches reads
// as `DateTime.Utc` too: the bridge then stops typechecking, which is the cue.

import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"

/** A raw table's string time expression, decoded as a `DateTime.Utc`. */
export const rawTimeAsUtc = <E extends CH.Expr<string, never>>(expr: E) =>
	CH.makeExpr(expr.toFragment(), T.dateTime.schema, undefined, [expr])

/**
 * A rollup time expression decoded as the wire string, for an endpoint whose
 * raw-table path still returns strings and so owns the output type.
 */
export const utcAsWireString = <E extends CH.Expr<DateTime.Utc, never>>(expr: E) =>
	CH.makeExpr(expr.toFragment(), T.dateTimeString.schema, undefined, [expr])
