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
	const headerLine = `| ${headers.join(" | ")} |`
	const sep = `|${headers.map(() => "---").join("|")}|`
	const dataLines = rows.map((row) => `| ${row.join(" | ")} |`)

	return [headerLine, sep, ...dataLines].join("\n")
}

export function truncate(str: string, maxLen = 80): string {
	if (str.length <= maxLen) return str
	return str.slice(0, maxLen - 3) + "..."
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
	const collapsed = text.replace(/\s+/g, " ").trim()
	return (max === undefined ? collapsed : truncate(collapsed, max))
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
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
	const runs = text.match(/`+/g)?.map((run) => run.length) ?? []
	const fence = "`".repeat(Math.max(3, ...runs.map((length) => length + 1)))
	return `${fence}\n${text}\n${fence}`
}
