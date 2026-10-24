// Renders the ingest load benchmark comment posted on PRs (ingest-bench.yml).
// Env: HEAD_LOAD_JSON / BASE_LOAD_JSON (comma-separated LoadSummary JSON paths; several
// mean median + min/max), CRITERION_OUTPUT, COMMENT_OUTPUT, GITHUB_SHA.
// The first line is a stable marker so the workflow updates its comment in place.
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const MARKER = "<!-- ingest-bench-comment -->"
// oxlint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g

type Run = Readonly<Record<string, unknown>>

const parsePaths = (raw: string | undefined): Array<string> =>
	(raw ?? "")
		.split(",")
		.map((piece) => piece.trim())
		.filter(Boolean)

const asRun = (parsed: unknown): Array<Run> =>
	typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? [{ ...parsed }] : []

// A truncated report from a crashed iteration is skipped, not fatal.
const loadRuns = async (raw: string | undefined): Promise<Array<Run>> =>
	(
		await Promise.all(
			parsePaths(raw)
				.filter((path) => existsSync(path))
				.map((path) =>
					Bun.file(path)
						.json()
						.then(asRun, () => []),
				),
		)
	).flat()

const numeric = (runs: ReadonlyArray<Run>, key: string): Array<number> =>
	runs.map((run) => run[key]).filter((value): value is number => typeof value === "number")

const median = (values: ReadonlyArray<number>): number | undefined => {
	if (values.length === 0) return undefined
	const sorted = values.toSorted((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

const fmt = (value: number | undefined, suffix = "", precision = 2): string => {
	if (value === undefined) return "n/a"
	if (Number.isInteger(value) && !suffix.endsWith("ms") && suffix !== " MiB" && suffix !== "%")
		return `${value}${suffix}`
	return `${value.toFixed(precision)}${suffix}`
}

const fmtRange = (values: ReadonlyArray<number>, suffix: string, precision: number): string =>
	values.length === 0
		? ""
		: `(min ${Math.min(...values).toFixed(precision)}, max ${Math.max(...values).toFixed(precision)}${suffix})`

const delta = (current: number | undefined, base: number | undefined, lowerIsBetter: boolean): string => {
	if (current === undefined || base === undefined) return "n/a"
	if (base === 0) return current === 0 ? "same" : "baseline 0"
	if (Math.abs(base) < 0.01) {
		const absolute = current - base
		const good = lowerIsBetter ? absolute <= 0 : absolute >= 0
		return `${absolute >= 0 ? "+" : ""}${absolute.toFixed(2)} ${good ? "better" : "worse"}`
	}
	const pct = ((current - base) / base) * 100
	const good = lowerIsBetter ? pct <= 0 : pct >= 0
	return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% ${good ? "better" : "worse"}`
}

const tail = (path: string | undefined, lines: number): string => {
	if (!path || !existsSync(path)) return "output unavailable"
	const content = readFileSync(path, "utf8").replace(ANSI_RE, "").replace(/\n+$/, "")
	return content.split(/\r?\n/).slice(-lines).join("\n")
}

const METRICS = [
	["Requests/sec", "request_rps", "", 2, false],
	["Rows/sec", "row_rps", "", 2, false],
	["p50 latency", "p50_ms", " ms", 2, true],
	["p95 latency", "p95_ms", " ms", 2, true],
	["p99 latency", "p99_ms", " ms", 2, true],
	["Export catch-up", "export_catchup_seconds", " s", 3, true],
	["Max RSS", "max_rss_mb", " MiB", 2, true],
	["Failures", "failures", "", 0, true],
] as const

const comparisonTable = (base: ReadonlyArray<Run>, head: ReadonlyArray<Run>): Array<string> => [
	"| Metric | main (median) | PR (median) | Delta |",
	"| --- | ---: | ---: | ---: |",
	...METRICS.map(([label, key, suffix, precision, lower]) => {
		const b = median(numeric(base, key))
		const h = median(numeric(head, key))
		return `| ${label} | ${fmt(b, suffix, precision)} | ${fmt(h, suffix, precision)} | ${delta(h, b, lower)} |`
	}),
]

const absoluteTable = (head: ReadonlyArray<Run>): Array<string> => [
	"| Metric | PR (median) | Spread |",
	"| --- | ---: | ---: |",
	...METRICS.map(([label, key, suffix, precision]) => {
		const values = numeric(head, key)
		return `| ${label} | ${fmt(median(values), suffix, precision)} | ${fmtRange(values, suffix, precision) || "—"} |`
	}),
]

const runsJson = (runs: ReadonlyArray<Run>): string =>
	runs.length === 0 ? "no runs captured" : JSON.stringify(runs, null, 2)

const details = (summary: string, runs: ReadonlyArray<Run>): Array<string> => [
	`<details><summary>${summary}</summary>`,
	"",
	"```json",
	runsJson(runs),
	"```",
	"",
	"</details>",
	"",
]

const out = process.env.COMMENT_OUTPUT
if (!out) throw new Error("COMMENT_OUTPUT is required")
const headRuns = await loadRuns(process.env.HEAD_LOAD_JSON)
const baseRuns = await loadRuns(process.env.BASE_LOAD_JSON)
const modeOf = (runs: ReadonlyArray<Run>): string => String(runs[0]?.ingest_mode ?? "tinybird")
const headMode = modeOf(headRuns)
const baseMode = modeOf(baseRuns)
const sameMode = baseRuns.length > 0 && baseMode === headMode

const body = [
	MARKER,
	"## Ingest Rust Test + Benchmark Results",
	"",
	`**Commit:** \`${process.env.GITHUB_SHA ?? "unknown"}\``,
	"",
]

if (sameMode) {
	body.push(
		`### Load Benchmark — \`${headMode}\` mode, median of ${headRuns.length} run(s) vs main`,
		"",
		...comparisonTable(baseRuns, headRuns),
		"",
		"Same code path on both sides (same `LOAD_TEST_INGEST_MODE`), so the delta column is meaningful. Numbers come from `ubuntu-latest`, which is noisy — treat single-digit-percent deltas as noise.",
		"",
	)
} else {
	const note =
		baseRuns.length > 0
			? `Baseline ran in \`${baseMode}\` mode while PR ran in \`${headMode}\` mode — cross-mode comparison is misleading, so only absolute PR numbers are shown.`
			: `No baseline benchmark on main yet (this PR introduces \`${headMode}\` mode). Once it lands, future PRs will get a real PR-vs-main delta automatically.`
	body.push(
		`### Load Benchmark — \`${headMode}\` mode, ${headRuns.length} run(s)`,
		"",
		...absoluteTable(headRuns),
		"",
		note,
		"",
	)
}

body.push(...details("PR load benchmark JSON (per-iteration)", headRuns))
if (baseRuns.length > 0) body.push(...details("main load benchmark JSON (per-iteration)", baseRuns))

const criterion = process.env.CRITERION_OUTPUT
if (criterion && existsSync(criterion)) {
	body.push(
		"### WAL-acked microbench (`cargo bench --bench ingest_bench`)",
		"",
		"```text",
		tail(criterion, 60),
		"```",
		"",
	)
}

writeFileSync(out, `${body.join("\n")}\n`)
