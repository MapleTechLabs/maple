import { LoadFailure } from "@maple/views/data/load-failure"
import { Schema } from "effect"

// The Schemas a page's Model and Messages wrap its reads in.

/** A read's settled answer: the success or the `LoadFailure` it failed with. */
export const LoadOutcome = <S extends Schema.Top>(success: S) => Schema.Result(success, LoadFailure)

/** A live collection's rows: `null` until its first snapshot. */
export const LiveRows = <S extends Schema.Top>(row: S) => Schema.NullOr(Schema.Array(row))
