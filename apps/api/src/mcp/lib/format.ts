export function formatDurationFromMs(ms: number): string {
	if (ms < 1) return `${(ms * 1000).toFixed(0)}us`
	if (ms < 1000) return `${ms.toFixed(1)}ms`
	return `${(ms / 1000).toFixed(2)}s`
}

export function formatPercent(value: number): string {
	return `${(value * 100).toFixed(2)}%`
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
 * A payload as a fenced code block, with a fence longer than any backtick run
 * inside it.
 *
 * A captured tool payload is arbitrary text — a fixed triple-backtick fence
 * around one that contains ``` is closed by the payload itself, and everything
 * the tool rendered after it reads as prose.
 */
export function fencedBlock(text: string, lang = ""): string {
	const runs = text.match(/`+/g)
	const fence = "`".repeat(Math.max(3, runs === null ? 0 : Math.max(...runs.map((run) => run.length)) + 1))
	return `${fence}${lang}\n${text}\n${fence}`
}
