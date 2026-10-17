/** A row in the shape `INSERT ... FORMAT JSONEachRow` takes: maps are objects, DateTime64 is text. */
export type WarehouseRow = Readonly<Record<string, unknown>>

/** Raw tables the seed writes; every rollup is filled by the schema's materialized views. */
export const TELEMETRY_TABLES = [
	"traces",
	"logs",
	"metrics_gauge",
	"metrics_sum",
	"metrics_histogram",
] as const
export type TelemetryTable = (typeof TELEMETRY_TABLES)[number]

export type TelemetryRows = Readonly<Record<TelemetryTable, ReadonlyArray<WarehouseRow>>>

export const emptyTelemetry = {
	traces: [],
	logs: [],
	metrics_gauge: [],
	metrics_sum: [],
	metrics_histogram: [],
} satisfies TelemetryRows

const pad = (value: number, width: number) => String(value).padStart(width, "0")

/** Epoch microseconds as a ClickHouse `DateTime64(9)` literal, always UTC. */
export const formatMicros = (micros: number): string => {
	const date = new Date(Math.floor(micros / 1000))
	const fraction = pad(Math.floor(micros % 1_000_000), 6)
	return `${date.toISOString().slice(0, 19).replace("T", " ")}.${fraction}000`
}

/** Epoch microseconds as a ClickHouse `DateTime` literal (second precision). */
export const formatSeconds = (micros: number): string =>
	new Date(Math.floor(micros / 1000)).toISOString().slice(0, 19).replace("T", " ")
