import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { stringifyJson } from "./json"
export function formatDurationFromMs(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}us`
	if (ms < 1000) return `${ms.toFixed(1)}ms`
	return `${(ms / 1000).toFixed(2)}s`
}

export function formatPercent(value: number): string {
	return `${(value * 100).toFixed(2)}%`
}

/** A share of a count, or `—` where nothing was counted: a rate over no calls
 *  is not 0%, and `0/0` renders as `NaN%`. */
export function percentOf(part: number, whole: number): string {
	return whole === 0 ? "—" : formatPercent(part / whole)
}

/** Percent change against a comparison window, or `—` where neither window
 *  measured anything: a delta against zero is not a percentage. */
export function formatDelta(current: number, previous: number): string {
	if (previous === 0) return current > 0 ? "+inf" : "—"
	const change = ((current - previous) / previous) * 100
	return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`
}

/** Change between two rates, in percentage points — a relative change between
 *  two percents is a rate of rates, which beside them reads as a third percent
 *  of the same kind (`2% → 5%` is `+3.00 pp`, not `+150.0%`). */
export function formatPointsDelta(current: number, previous: number): string {
	const change = (current - previous) * 100
	return `${change >= 0 ? "+" : ""}${change.toFixed(2)} pp`
}

export function formatNumber(value: number | bigint): string {
	return Number(value).toLocaleString("en-US")
}

export function formatTable(headers: string[], rows: string[][]): string {
	const headerLine = `| ${Arr.join(headers, " | ")} |`
	const sep = `|${Arr.join(
		Arr.map(headers, () => "---"),
		"|",
	)}|`
	const dataLines = Arr.map(rows, (row) => `| ${Arr.join(row, " | ")} |`)

	return Arr.join([headerLine, sep, ...dataLines], "\n")
}

export function truncate(str: string, maxLen = 80): string {
	if (str.length <= maxLen) return str
	return Str.slice(0, maxLen - 3)(str) + "..."
}

/**
 * Text someone outside Maple wrote (a description, a telemetry value) as one JSON-quoted line: it
 * cannot end its quote, start a new section or read as the tool's own text.
 */
export function untrustedText(text: string, max = 300): string {
	const line = truncate(Str.replace(/\s+/g, " ")(text), max)
	return stringifyJson(line) ?? `"${Str.replace(/"/g, "'")(line)}"`
}

/** A log's cause-bearing attributes, one indented `key: value` line each, for under its log line. */
export function logAttributeLines(
	attributes: Readonly<Record<string, string>> | undefined,
	indent: string,
): string {
	return Arr.join(
		Arr.map(
			Rec.toEntries(attributes ?? {}),
			([key, value]) => `\n${indent}${untrustedText(key, 120)}: ${untrustedText(value, 300)}`,
		),
		"",
	)
}

const unicodeEscape = (char: string) =>
	`\\u${Str.padStart(4, "0")(Option.getOrElse(Str.codePointAt(0)(char), () => 0).toString(16))}`

/**
 * A telemetry value that identifies something (a group, a series) as one JSON-quoted line. Unlike
 * {@link untrustedText} its whitespace is escaped, not collapsed, so two names stay two names, in
 * a table cell too.
 */
export function untrustedName(text: string, max = 200): string {
	const line = truncate(text, max)
	const quoted = stringifyJson(line) ?? `"${Str.replace(/"/g, "'")(Str.replace(/\s/g, " ")(line))}"`
	// Every whitespace but a lone space becomes a JSON escape, which table cells do not collapse.
	return Arr.join(
		Arr.map(Str.split("")(quoted), (char, i) =>
			char === " "
				? quoted[i - 1] === " "
					? "\\u0020"
					: char
				: /\s/.test(char)
					? unicodeEscape(char)
					: char,
		),
		"",
	)
}

/**
 * Free text as a markdown table cell: collapsed to one line, clipped where the
 * caller names a ceiling, and its pipes escaped last.
 *
 * A captured error message is arbitrary text — an unescaped `|` in one shifts
 * every column after it, and a payload's newline ends the row. Escaping after
 * the clip is what keeps a cut from leaving a trailing `\` that would escape
 * the delimiter itself.
 */
export function tableCell(text: string, max?: number): string {
	const collapsed = Str.trim(Str.replace(/\s+/g, " ")(text))
	return Str.replace(/[\\|]/g, "\\$&")(max === undefined ? collapsed : truncate(collapsed, max))
}

/**
 * A payload as a fenced code block, with a fence longer than any backtick run
 * inside it.
 *
 * A captured tool payload is arbitrary text — a fixed triple-backtick fence
 * around one that contains ``` is closed by the payload itself, and everything
 * the tool rendered after it reads as prose.
 */
export function fencedBlock(text: string): string {
	const runs = Option.match(Str.match(/`+/g)(text), {
		onNone: () => [],
		onSome: (matched) => Arr.map(matched, (run) => run.length),
	})
	const fence = Str.repeat(Math.max(3, ...Arr.map(runs, (length) => length + 1)))("`")
	return `${fence}\n${text}\n${fence}`
}

/** A UTC timestamp cut to whole seconds (`YYYY-MM-DD HH:mm:ss`), for `timestamp` hints and Start columns. */
export function toSecondTimestamp(value: string): string {
	return Str.replace("T", " ")(Str.slice(0, 19)(value))
}

/** The key with the highest count; "unknown" when there is none or it is blank. */
export const topKey = (counts: { readonly [key: string]: number }): string =>
	Arr.reduce(Rec.toEntries(counts), { key: "", n: -1 }, (best, [key, n]) =>
		n > best.n ? { key, n } : best,
	).key || "unknown"

/** "1 log", "2 logs": a formatted count with its noun in the right number. */
export const countOf = (n: number, singular: string, plural = `${singular}s`): string =>
	`${formatNumber(n)} ${n === 1 ? singular : plural}`
