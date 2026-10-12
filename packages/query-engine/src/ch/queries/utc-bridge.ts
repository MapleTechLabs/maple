// A type-only bridge that reads a `DateTime.Utc` time expression as the wire
// string, for rows that go to `ingest` as they are. It does not change the SQL.

import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import * as T from "@maple-dev/effect-orm/clickhouse"

/** A time expression decoded as the wire string, for an ingest-shaped row. */
export const utcAsWireString = <E extends CH.Expr<DateTime.Utc, never>>(expr: E) =>
	CH.makeExpr(expr.toFragment(), T.dateTimeString.schema, undefined, [expr])
