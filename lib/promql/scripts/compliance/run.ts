/**
 * Compares our engine against a real Prometheus on the same data.
 *
 * bun run scripts/compliance/run.ts [--keep] [filter]
 *
 * Needs Docker. Backfills the dataset with promtool, starts Prometheus on
 * :19090, runs every query as range and instant queries on both sides and
 * prints a diff. Exit code 1 on any mismatch.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { memorySource, type QueryResult, runQuery } from "../../src/index"
import { buildDataset, DATA_END_MS, DATA_START_MS, toOpenMetrics } from "./dataset"
import { ALL_QUERIES, EXPECTED_ERRORS, LATER_UPSTREAM_FIXES } from "./queries"

const IMAGE = "prom/prometheus:v3.5.0"
const PORT = 19090
const CONTAINER = "maple-promql-compliance"
const keep = process.argv.includes("--keep")
const filter = process.argv.slice(2).find((a) => !a.startsWith("--"))

const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8" })

const startPrometheus = (data: string): void => {
	const dir = mkdtempSync(join(tmpdir(), "promql-compliance-"))
	mkdirSync(join(dir, "tsdb"))
	writeFileSync(join(dir, "data.om"), data)
	writeFileSync(join(dir, "prometheus.yml"), "global:\n  scrape_interval: 15s\n")
	execFileSync("chmod", ["-R", "777", dir])
	docker("rm", "-f", CONTAINER)
	docker(
		"run",
		"--rm",
		"-v",
		`${dir}:/work`,
		"--entrypoint",
		"promtool",
		IMAGE,
		"tsdb",
		"create-blocks-from",
		"openmetrics",
		"/work/data.om",
		"/work/tsdb",
	)
	docker(
		"run",
		"-d",
		"--name",
		CONTAINER,
		"-p",
		`${PORT}:9090`,
		"-v",
		`${dir}:/work`,
		IMAGE,
		"--config.file=/work/prometheus.yml",
		"--storage.tsdb.path=/work/tsdb",
		"--storage.tsdb.retention.time=100y",
		"--query.lookback-delta=5m",
		"--enable-feature=promql-experimental-functions",
	)
}

const waitReady = async (): Promise<void> => {
	for (let i = 0; i < 60; i++) {
		const ok = await fetch(`http://localhost:${PORT}/-/ready`).then(
			(r) => r.ok,
			() => false,
		)
		if (ok) return
		await new Promise((r) => setTimeout(r, 500))
	}
	throw new Error("Prometheus did not become ready")
}

type Series = { labels: Record<string, string>; points: Array<[number, number]> }
type Typed = { resultType: string; series: Series[] }

const parseValue = (v: string): number => (v === "+Inf" ? Infinity : v === "-Inf" ? -Infinity : Number(v))

const promQuery = async (path: string, params: Record<string, string>): Promise<Typed | string> => {
	const url = `http://localhost:${PORT}/api/v1/${path}?${new URLSearchParams(params)}`
	const body = (await (await fetch(url)).json()) as {
		status: string
		error?: string
		data?: { resultType: string; result: unknown }
	}
	if (body.status !== "success" || body.data === undefined) return `error: ${body.error}`
	const { resultType, result } = body.data
	if (resultType === "scalar") {
		const [t, v] = result as [number, string]
		return { resultType, series: [{ labels: {}, points: [[t * 1000, parseValue(v)]] }] }
	}
	if (resultType === "vector") {
		return {
			resultType,
			series: (result as Array<{ metric: Record<string, string>; value: [number, string] }>).map(
				(s) => ({
					labels: s.metric,
					points: [[s.value[0] * 1000, parseValue(s.value[1])]],
				}),
			),
		}
	}
	return {
		resultType,
		series: (result as Array<{ metric: Record<string, string>; values: Array<[number, string]> }>).map(
			(s) => ({
				labels: s.metric,
				points: s.values.map(([t, v]) => [t * 1000, parseValue(v)]),
			}),
		),
	}
}

const oursSeries = (result: QueryResult): Series[] => {
	switch (result.resultType) {
		case "scalar":
			return [{ labels: {}, points: [[result.result.t, result.result.v]] }]
		case "string":
			return []
		case "vector":
			return result.result.map((s) => ({ labels: { ...s.labels }, points: [[s.t, s.value]] }))
		case "matrix":
			return result.result.map((s) => ({
				labels: { ...s.labels },
				points: s.points.map((p) => [p.t, p.v]),
			}))
	}
}

const ours = (result: QueryResult): Typed => ({ resultType: result.resultType, series: oursSeries(result) })

const key = (labels: Record<string, string>): string =>
	JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))

const close = (a: number, b: number): boolean =>
	(Number.isNaN(a) && Number.isNaN(b)) ||
	a === b ||
	(Number.isFinite(a) &&
		Number.isFinite(b) &&
		Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)))

const diff = (typedExpected: Typed, typedActual: Typed): string | undefined => {
	if (typedExpected.resultType !== typedActual.resultType)
		return `result type ${typedActual.resultType}, want ${typedExpected.resultType}`
	const expected = typedExpected.series
	const actual = typedActual.series
	const want = new Map(expected.map((s) => [key(s.labels), s]))
	const got = new Map(actual.map((s) => [key(s.labels), s]))
	if (got.size !== actual.length) return `duplicate series in our result`
	if (want.size !== expected.length) return `duplicate series in the expected result`
	for (const k of want.keys()) if (!got.has(k)) return `missing series ${k}`
	for (const k of got.keys()) if (!want.has(k)) return `unexpected series ${k}`
	for (const [k, w] of want) {
		const g = got.get(k)
		if (g === undefined) continue
		const gotByT = new Map(g.points.map(([t, v]) => [t, v]))
		for (const [t, v] of w.points) {
			const mine = gotByT.get(t)
			if (mine === undefined) return `${k}: missing point at ${t}`
			if (!close(v, mine)) return `${k} @ ${t}: want ${v}, got ${mine}`
		}
		if (g.points.length !== w.points.length)
			return `${k}: ${g.points.length} points, want ${w.points.length}`
	}
	return undefined
}

const main = async (): Promise<void> => {
	const dataset = buildDataset()
	startPrometheus(toOpenMetrics(dataset))
	await waitReady()
	const source = memorySource(dataset)
	const cases: Array<{
		name: string
		query: string
		params: { startMs: number; endMs: number; stepMs: number }
	}> = []
	for (const query of ALL_QUERIES.filter((q) => filter === undefined || q.includes(filter))) {
		for (const stepMs of [15_000, 60_000, 37_000]) {
			cases.push({
				name: `range step=${stepMs / 1000}s`,
				query,
				params: { startMs: DATA_START_MS + 1800_000, endMs: DATA_END_MS - 600_000, stepMs },
			})
		}
		for (const at of [DATA_START_MS + 3600_000, DATA_START_MS + 3600_000 + 7_000, DATA_END_MS]) {
			cases.push({
				name: `instant @${(at - DATA_START_MS) / 1000}s`,
				query,
				params: { startMs: at, endMs: at, stepMs: 0 },
			})
		}
	}
	let failures = 0
	let upstreamFixed = 0
	for (const c of cases) {
		const { startMs, endMs, stepMs } = c.params
		const expected =
			startMs === endMs
				? await promQuery("query", { query: c.query, time: String(startMs / 1000) })
				: await promQuery("query_range", {
						query: c.query,
						start: String(startMs / 1000),
						end: String(endMs / 1000),
						step: String(stepMs / 1000),
					})
		const result = runQuery(c.query, c.params, source)
		// Both sides failing only passes for a query listed as an expected error.
		const wantsError = EXPECTED_ERRORS.has(c.query)
		const problem =
			typeof expected === "string"
				? Result.isFailure(result)
					? wantsError
						? undefined
						: `prometheus ${expected}; we failed: ${result.failure.message}`
					: `prometheus ${expected}, we succeeded`
				: wantsError
					? `expected an error, prometheus succeeded`
					: Result.isFailure(result)
						? `we failed: ${result.failure.message}`
						: diff(expected, ours(result.success))
		// A later upstream fix explains a different value, never an error on either side.
		const valuesDiffer = typeof expected !== "string" && !wantsError && Result.isSuccess(result)
		if (problem !== undefined && valuesDiffer && LATER_UPSTREAM_FIXES.has(c.query)) {
			upstreamFixed += 1
			console.log(`DIFF ${c.query}  [${c.name}] (follows a later Prometheus fix)\n     ${problem}`)
		} else if (problem !== undefined) {
			failures += 1
			console.log(`FAIL ${c.query}  [${c.name}]\n     ${problem}`)
		}
	}
	console.log(
		`\n${cases.length - failures - upstreamFixed}/${cases.length} cases match, ${upstreamFixed} follow a later Prometheus fix`,
	)
	if (!keep) docker("rm", "-f", CONTAINER)
	process.exit(failures === 0 ? 0 : 1)
}

await main()
