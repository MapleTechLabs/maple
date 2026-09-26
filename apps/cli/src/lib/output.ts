import { Effect, Option, Predicate } from "effect"
import * as Flag from "effect/unstable/cli/Flag"
import * as GlobalFlag from "effect/unstable/cli/GlobalFlag"
import { bold, dim } from "./style"

/**
 * Default output is pretty-printed JSON with raw numbers, for agents and
 * scripts. `--format table` (or MAPLE_FORMAT=table) renders for humans:
 * aligned columns, rounded numbers with units, nested results as sections.
 * Everything that is not the result (empty-result notes, pagination hints)
 * goes to stderr, so stdout stays machine-clean in both formats.
 */
export type OutputFormat = "json" | "table"

/**
 * `--format` as a global setting, so handlers read the parsed value instead of
 * scanning argv. Register it on the root with `Command.withGlobalFlags`.
 */
export const OutputFormatSetting = GlobalFlag.Setting("format")({
	flag: Flag.Literals("format", ["json", "table"]).pipe(
		Flag.withDescription("Output format: json (default) or table. MAPLE_FORMAT sets the default."),
		Flag.optional,
	),
})

export const printJson = (data: unknown) =>
	Effect.sync(() => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`))

const isFormat = (value: string | undefined): value is OutputFormat => value === "json" || value === "table"

/** The last `--format` on the command line, in either `--format x` or `--format=x` form. */
export const argvFormat = (argv: ReadonlyArray<string>): OutputFormat | undefined => {
	let found: string | undefined
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--") break
		if (arg === "--format") found = argv[i + 1]
		else if (arg?.startsWith("--format=")) found = arg.slice("--format=".length)
	}
	return isFormat(found) ? found : undefined
}

/** Parsed `--format` when the setting is registered, else argv, then MAPLE_FORMAT, then json. */
export const resolveFormat: Effect.Effect<OutputFormat> = Effect.map(
	Effect.serviceOption(OutputFormatSetting),
	(setting) => {
		const explicit = Option.match(setting, {
			onSome: Option.getOrUndefined,
			onNone: () => argvFormat(process.argv),
		})
		const env = process.env.MAPLE_FORMAT
		return explicit ?? (isFormat(env) ? env : "json")
	},
)

// ---------------------------------------------------------------------------
// Cell formatting (table mode only; JSON keeps raw numbers)

const integerFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const decimalFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })

export const formatCount = (n: number): string =>
	Number.isInteger(n) ? integerFormat.format(n) : decimalFormat.format(n)

/** A 0..1 ratio as a percentage: 0.0077 -> 0.77%, 0.15 -> 15.2%. */
export const formatPercent = (ratio: number): string => {
	if (!Number.isFinite(ratio) || ratio === 0) return "0%"
	const pct = ratio * 100
	const digits = pct < 0.01 ? 3 : pct < 10 ? 2 : 1
	return `${Number(pct.toFixed(digits))}%`
}

/** Milliseconds with a unit that keeps 3-4 significant digits. */
export const formatDuration = (ms: number): string => {
	if (!Number.isFinite(ms)) return String(ms)
	const abs = Math.abs(ms)
	if (abs === 0) return "0ms"
	if (abs < 1) return `${Number((ms * 1000).toFixed(0))}µs`
	if (abs < 100) return `${Number(ms.toFixed(2))}ms`
	if (abs < 1000) return `${Number(ms.toFixed(1))}ms`
	if (abs < 60_000) return `${Number((ms / 1000).toFixed(2))}s`
	const minutes = Math.floor(ms / 60_000)
	return `${minutes}m${Math.round((ms - minutes * 60_000) / 1000)}s`
}

export const formatDecimal = (n: number): string => {
	if (Number.isInteger(n)) return integerFormat.format(n)
	const abs = Math.abs(n)
	const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 4
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n)
}

/** `2026-09-25 23:36:29.481465000` -> `2026-09-25 23:36:29`; anything else unchanged. */
export const formatTimestamp = (value: string): string =>
	/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value) ? value.slice(0, 19).replace("T", " ") : value

const DURATION_KEY = /(Ms|Duration)$/
const RATE_KEY = /Rate$/
const COUNT_KEY = /(count|Count|throughput|Throughput|total|Total|Sampled|sampleSize)$/
const SCORE_KEY = /^apdex/

/** Format one generic cell by its key's naming convention. */
export const formatByKey = (key: string, value: unknown): string => {
	if (value === null || value === undefined) return ""
	if (typeof value === "number") {
		if (RATE_KEY.test(key)) return formatPercent(value)
		if (DURATION_KEY.test(key)) return formatDuration(value)
		if (COUNT_KEY.test(key)) return formatCount(value)
		if (SCORE_KEY.test(key)) return value.toFixed(3)
		return formatDecimal(value)
	}
	if (typeof value === "string") return formatTimestamp(value)
	if (typeof value === "boolean") return value ? "yes" : "no"
	if (Array.isArray(value)) return value.map((v) => formatByKey(key, v)).join(", ")
	return JSON.stringify(value)
}

/** `p95Ms` -> `P95`, `avgDurationMs` -> `AVG DURATION`, `errorRate` -> `ERROR RATE`. */
export const headerFor = (key: string): string =>
	key
		.replace(/Ms$/, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/_/g, " ")
		.toUpperCase()

// ---------------------------------------------------------------------------
// Tables

export interface Column<R> {
	readonly header: string
	readonly cell: (row: R) => string
	readonly align?: "left" | "right"
	/** Truncate longer cells with an ellipsis. */
	readonly maxWidth?: number
}

const truncate = (s: string, max: number | undefined): string => {
	const flat = s.replace(/\s*\n\s*/g, " ")
	return max !== undefined && flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat
}

export const renderTable = <R>(columns: ReadonlyArray<Column<R>>, rows: ReadonlyArray<R>): string => {
	const cells = rows.map((row) => columns.map((c) => truncate(c.cell(row), c.maxWidth)))
	const widths = columns.map((c, i) => Math.max(c.header.length, ...cells.map((r) => (r[i] ?? "").length)))
	const pad = (s: string, i: number): string => {
		const fill = " ".repeat(Math.max(0, (widths[i] ?? 0) - s.length))
		return columns[i]?.align === "right" ? fill + s : s + fill
	}
	const line = (values: ReadonlyArray<string>) => values.map(pad).join("  ").trimEnd()
	const header = bold(line(columns.map((c) => c.header)))
	return [header, ...cells.map(line)].join("\n")
}

/** Aligned `key  value` lines for a record of scalars. */
export const renderFields = (fields: ReadonlyArray<readonly [string, string]>): string => {
	const width = Math.max(0, ...fields.map(([k]) => k.length))
	return fields.map(([k, v]) => `${dim(k.padEnd(width))}  ${v}`).join("\n")
}

const isScalar = (v: unknown): boolean =>
	v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean"

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
	Predicate.isObject(v) && !Array.isArray(v)

/** A cell-per-key table over rows, flattening one level of nesting and joining arrays. */
export const autoTable = (
	rows: ReadonlyArray<unknown>,
	options?: { readonly raw?: boolean; readonly maxWidth?: number },
): string => {
	const flat = rows.map((row): Record<string, unknown> => {
		if (!isRecord(row)) return { value: row }
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(row)) {
			if (isRecord(v)) for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2
			else out[k] = v
		}
		return out
	})
	const keys: Array<string> = []
	for (const row of flat) for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k)
	const raw = options?.raw === true
	const columns = keys.map(
		(key): Column<Record<string, unknown>> => ({
			header: raw ? key : headerFor(key),
			cell: (row) => {
				const v = row[key]
				if (!raw) return formatByKey(key, v)
				return v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)
			},
			align: flat.some((row) => typeof row[key] === "number") ? "right" : "left",
			maxWidth: options?.maxWidth ?? 80,
		}),
	)
	return renderTable(columns, flat)
}

/** Generic rendering: scalars as fields, each array property as its own titled table. */
export const autoSections = (data: unknown): ReadonlyArray<Section> => {
	if (Array.isArray(data)) return [{ body: autoTable(data) }]
	if (!isRecord(data)) return [{ body: formatByKey("value", data) }]
	const fields: Array<readonly [string, string]> = []
	const sections: Array<Section> = []
	for (const [key, value] of Object.entries(data)) {
		if (Array.isArray(value)) {
			if (value.length > 0) sections.push({ title: headerFor(key), body: autoTable(value) })
		} else if (isRecord(value) && Object.values(value).every(isScalar)) {
			for (const [k2, v2] of Object.entries(value)) fields.push([`${key}.${k2}`, formatByKey(k2, v2)])
		} else if (isScalar(value)) {
			fields.push([key, formatByKey(key, value)])
		} else {
			fields.push([key, JSON.stringify(value)])
		}
	}
	return fields.length > 0 ? [{ body: renderFields(fields) }, ...sections] : sections
}

// ---------------------------------------------------------------------------
// Printing

export interface Section {
	readonly title?: string
	readonly body: string
}

export interface View<A> {
	/** Table-mode rendering; the generic `autoSections` when absent. */
	readonly table?: (data: A) => ReadonlyArray<Section>
	/** Whether the result holds nothing to show; defaults to "every array is empty". */
	readonly isEmpty?: (data: A) => boolean
	/** Printed to stderr when the result is empty, e.g. `No services in the last 6h`. */
	readonly empty?: string
	/** Extra stderr lines in table mode, e.g. a pagination hint. */
	readonly notes?: (data: A) => ReadonlyArray<string>
	/** Raw SQL rows: keep the column names and values as they came. */
	readonly raw?: boolean
}

/** True when `data` is an empty array, or an object whose array properties are all empty. */
export const isEmptyResult = (data: unknown): boolean => {
	if (Array.isArray(data)) return data.length === 0
	if (!isRecord(data)) return false
	const arrays = Object.values(data).filter(Array.isArray)
	return arrays.length > 0 && arrays.every((a) => a.length === 0)
}

export const renderSections = (sections: ReadonlyArray<Section>): string =>
	sections.map((s) => (s.title === undefined ? s.body : `${bold(s.title)}\n${s.body}`)).join("\n\n")

/** Format-aware result printer: JSON by default, `--format table` for humans. */
export const printResult = <A>(data: A, view?: View<A>): Effect.Effect<void> =>
	Effect.gen(function* () {
		const format = yield* resolveFormat
		const empty = view?.isEmpty ? view.isEmpty(data) : isEmptyResult(data)
		if (format === "json") {
			process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
		} else if (!empty) {
			const sections = view?.table
				? view.table(data)
				: Array.isArray(data)
					? [{ body: autoTable(data, { raw: view?.raw === true }) }]
					: autoSections(data)
			process.stdout.write(`${renderSections(sections)}\n`)
			for (const note of view?.notes?.(data) ?? []) process.stderr.write(`${dim(note)}\n`)
		}
		if (empty && view?.empty !== undefined) process.stderr.write(`${view.empty}\n`)
	})
