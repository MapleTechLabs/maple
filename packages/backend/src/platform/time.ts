/**
 * Converters between the app's epoch-ms number convention and `Date`s, for the
 * boundaries that still want one. Postgres needs none: the tables read and write
 * timestamptz as epoch ms (`PG.timestamptzMillis`).
 */
import { DateTime, Option } from "effect"

export function msToDate(ms: number): Date
export function msToDate(ms: number | null): Date | null
export function msToDate(ms: number | null | undefined): Date | null
export function msToDate(ms: number | null | undefined): Date | null {
	return ms === null || ms === undefined ? null : new Date(ms)
}

/**
 * Epoch-ms to an ISO 8601 string, for a whole-statement `Orm.sql` template, whose
 * values reach the driver verbatim. Pair it with an explicit `::timestamptz`.
 * Inside a builder query use `PG.typedValue(T.columns.at, ms)` instead.
 */
export function msToSqlTimestamp(ms: number): string {
	return new Date(ms).toISOString()
}

export function dateToMs(date: Date): number
export function dateToMs(date: Date | null): number | null
export function dateToMs(date: Date | null | undefined): number | null
export function dateToMs(date: Date | null | undefined): number | null {
	return date === null || date === undefined ? null : date.getTime()
}

/**
 * Epoch milliseconds of a timestamp from outside the warehouse (an API response, a header, a
 * request), or `NaN` when it is not one. A string without a zone reads as UTC on every host,
 * which `Date.parse` does not promise. Warehouse strings use `parseWarehouseDateTime`.
 */
export const timestampMs = (value: string): number =>
	Option.match(DateTime.make(value), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis })
