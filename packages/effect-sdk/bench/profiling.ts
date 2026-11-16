// What continuous profiling costs a service: throughput, CPU, tail latency, event-loop stalls
// and profile volume, with profiling off and on, each run in a fresh process against a local
// collector that answers 200 to everything.
//
//   bun run bench:profiling [--runtime node|bun] [--scenarios off,on,on-nolink,on-1khz]
//     [--duration 20] [--warmup 5] [--runs 3] [--window 10] [--concurrency 32] [--spans 20]
//     [--work 2000] [--rate <req/s>] [--load-functions 0] [--stall-ms 10] [--out <file.json>]
//
// `--window` defaults to 10 s, not the SDK's 60 s, so a 20 s run sees restarts; the per-restart
// pause is the same, only how often it happens changes. `--rate` defaults to half of what the
// `off` run sustained. `--load-functions N` compiles N extra functions, standing in for a large
// app, since the restart pause grows with the code V8 has loaded.
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
import { cpus } from "node:os"
import { fileURLToPath } from "node:url"
import { Array as Arr, Order, Schema } from "effect"
import { type ProfilingSetting, type WorkerConfig, WorkerFailed, WorkerResult } from "./profiling-shared.ts"

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
	const index = args.indexOf(`--${name}`)
	return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const number = (name: string, fallback: number): number => Number(flag(name, String(fallback)))

const runtime = flag("runtime", "node")
const runs = number("runs", 3)
const windowMs = number("window", 10) * 1000
const fixedRate = number("rate", 0)
const out = flag("out", "")

const SCENARIOS = new Map<string, ProfilingSetting | false>([
	["off", false],
	["on", { window: windowMs, samplingIntervalMicros: 10_000, linkSpans: true }],
	["on-nolink", { window: windowMs, samplingIntervalMicros: 10_000, linkSpans: false }],
	["on-1khz", { window: windowMs, samplingIntervalMicros: 1_000, linkSpans: true }],
])
const scenarios = flag("scenarios", "off,on,on-nolink,on-1khz").split(",")
const unknown = scenarios.filter((name) => !SCENARIOS.has(name))
if (unknown.length > 0) {
	process.stderr.write(`unknown scenarios: ${unknown.join(", ")}\n`)
	process.exit(1)
}

// The collector: counts what each run exports, per OTLP path.
let received: Record<string, { requests: number; bytes: number }> = {}
const collector = createServer((req, res) => {
	const path = req.url ?? "/"
	const entry = (received[path] ??= { requests: 0, bytes: 0 })
	entry.requests += 1
	req.on("data", (chunk: Buffer) => {
		entry.bytes += chunk.length
	})
	req.on("end", () => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end("{}")
	})
})
await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve))
const address = collector.address()
const endpoint = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : ""

const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(WorkerResult))

const workerPath = fileURLToPath(new URL("./profiling-worker.ts", import.meta.url))

interface Run {
	readonly scenario: string
	readonly result: WorkerResult
	readonly profiles: { requests: number; bytes: number }
}

const runWorker = (scenario: string, mode: WorkerConfig["mode"], rate: number): Promise<Run> => {
	const config: WorkerConfig = {
		profiling: SCENARIOS.get(scenario) ?? false,
		endpoint,
		mode,
		durationMs: number("duration", 20) * 1000,
		warmupMs: number("warmup", 5) * 1000,
		concurrency: number("concurrency", 32),
		spansPerRequest: number("spans", 20),
		workPerSpan: number("work", 2000),
		rate,
		loadFunctions: number("load-functions", 0),
		stallMs: number("stall-ms", 10),
	}
	received = {}
	return new Promise((resolve, reject) => {
		const child = spawn(runtime, [workerPath, JSON.stringify(config)], {
			stdio: ["ignore", "pipe", "inherit"],
		})
		let stdout = ""
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.on("close", (code) => {
			const line = stdout.split("\n").find((l) => l.startsWith("RESULT "))
			if (code !== 0 || line === undefined) {
				reject(
					new WorkerFailed({
						message: `${scenario} ${mode} run exited ${code} without a result`,
						scenario,
						mode,
						exitCode: code,
					}),
				)
				return
			}
			resolve({
				scenario,
				result: decodeResult(line.slice("RESULT ".length)),
				profiles: received["/v1development/profiles"] ?? { requests: 0, bytes: 0 },
			})
		})
	})
}

/** Every scenario once per round, in a rotated order, so machine drift spreads across them. */
const runRounds = async (
	mode: WorkerConfig["mode"],
	rate: number,
	names: ReadonlyArray<string> = scenarios,
): Promise<Array<Run>> => {
	const order = Arr.flatMap(Arr.range(0, runs - 1), (round) =>
		Arr.map(names, (_, i) => names[(i + round) % names.length] ?? "off"),
	)
	return order.reduce<Promise<Array<Run>>>(async (done, scenario, index) => {
		const previous = await done
		process.stderr.write(`[${mode}] ${index + 1}/${order.length} ${scenario}\n`)
		return [...previous, await runWorker(scenario, mode, rate)]
	}, Promise.resolve([]))
}

const median = (values: ReadonlyArray<number>): number => {
	const sorted = Arr.sort(values, Order.Number)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}
const of = (all: ReadonlyArray<Run>, scenario: string, pick: (run: Run) => number): number =>
	median(all.filter((run) => run.scenario === scenario).map(pick))

const fmt = (value: number, digits = 1): string => value.toFixed(digits)
const delta = (value: number, base: number): string =>
	base === 0 || !scenarios.includes("off")
		? ""
		: `${value >= base ? "+" : ""}${fmt(((value - base) / base) * 100)}%`
const table = (header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string =>
	Arr.join(
		[
			`| ${header.join(" | ")} |`,
			`|${header.map(() => "---").join("|")}|`,
			...rows.map((row) => `| ${row.join(" | ")} |`),
		],
		"\n",
	)

const throughputRuns = await runRounds("throughput", 0)
const reqPerSec = (run: Run) => run.result.completed / (run.result.wallMs / 1000)
const cpuPerRequest = (run: Run) => run.result.cpuMicros / run.result.completed
const baseThroughput = scenarios.includes("off") ? of(throughputRuns, "off", reqPerSec) : 0
const rate =
	fixedRate > 0
		? fixedRate
		: Math.round(
				(baseThroughput > 0 ? baseThroughput : of(throughputRuns, scenarios[0] ?? "off", reqPerSec)) /
					2,
			)
const latencyRuns = await runRounds("latency", rate)
const profiled = scenarios.filter((s) => SCENARIOS.get(s) !== false)
const restartRuns = await runRounds("restart", 0, profiled)
collector.close()

const baseCpu = of(latencyRuns, "off", (run) => run.result.cpuMicros / run.result.wallMs / 10)
const cpuPercent = (run: Run) => run.result.cpuMicros / run.result.wallMs / 10
const worstStall = (run: Run) => Math.max(0, ...run.result.stalls.map((stall) => stall.ms))

const environment = `${runtime} ${runtime === "node" ? process.version : ""}, ${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} cores; ${runs} runs per scenario (medians), window ${windowMs / 1000}s, ${number("spans", 20)} spans/request, work ${number("work", 2000)}, ${number("load-functions", 0)} extra functions`

const report = Arr.join(
	[
		`## Continuous profiling overhead`,
		"",
		environment,
		"",
		`### Saturated throughput (closed loop, concurrency ${number("concurrency", 32)})`,
		"",
		table(
			["scenario", "req/s", "vs off", "CPU µs/req"],
			scenarios.map((s) => {
				const value = of(throughputRuns, s, reqPerSec)
				return [
					s,
					fmt(value, 0),
					delta(value, baseThroughput),
					fmt(of(throughputRuns, s, cpuPerRequest), 0),
				]
			}),
		),
		"",
		`### Fixed load (open loop, ${rate} req/s)`,
		"",
		table(
			[
				"scenario",
				"CPU %",
				"vs off",
				"p50 ms",
				"p99 ms",
				"p99.9 ms",
				"max ms",
				`stalls ≥${number("stall-ms", 10)}ms`,
				"worst stall ms",
				"peak RSS MB",
			],
			scenarios.map((s) => {
				const cpu = of(latencyRuns, s, cpuPercent)
				return [
					s,
					fmt(cpu),
					delta(cpu, baseCpu),
					fmt(
						of(latencyRuns, s, (run) => run.result.latencies.p50),
						2,
					),
					fmt(
						of(latencyRuns, s, (run) => run.result.latencies.p99),
						2,
					),
					fmt(
						of(latencyRuns, s, (run) => run.result.latencies.p999),
						2,
					),
					fmt(
						of(latencyRuns, s, (run) => run.result.latencies.max),
						1,
					),
					fmt(
						of(latencyRuns, s, (run) => run.result.stalls.length),
						0,
					),
					fmt(of(latencyRuns, s, worstStall), 1),
					fmt(
						of(latencyRuns, s, (run) => run.result.peakRssBytes / 1e6),
						0,
					),
				]
			}),
		),
		"",
		"### Profile volume (fixed load, uncompressed OTLP JSON as sent)",
		"",
		table(
			["scenario", "profiles/run", "KB/profile", "MB/hour"],
			scenarios
				.filter((s) => SCENARIOS.get(s) !== false)
				.map((s) => [
					s,
					fmt(
						of(latencyRuns, s, (run) => run.profiles.requests),
						0,
					),
					fmt(
						of(
							latencyRuns,
							s,
							(run) => run.profiles.bytes / Math.max(1, run.profiles.requests) / 1024,
						),
						0,
					),
					fmt(
						of(
							latencyRuns,
							s,
							(run) => ((run.profiles.bytes / run.result.profiledMs) * 3_600_000) / 1e6,
						),
						1,
					),
				]),
		),
		"",
		"### Window restart: what V8 itself costs",
		"",
		"`Profiler.stop` and `Profiler.start` timed directly, under saturated load rather than the fixed load above, so it shows how long V8's own restart takes, not an exact share of the stalls above.",
		"",
		table(
			["scenario", "stop ms (median)", "stop ms (max)", "start ms (median)", "profile nodes"],
			profiled.map((s) => {
				const windows = restartRuns
					.filter((run) => run.scenario === s)
					.flatMap((run) => run.result.restarts ?? [])
				return [
					s,
					fmt(median(windows.map((w) => w.stopMs))),
					fmt(Math.max(0, ...windows.map((w) => w.stopMs))),
					fmt(median(windows.map((w) => w.startMs))),
					fmt(median(windows.map((w) => w.nodes)), 0),
				]
			}),
		),
	],
	"\n",
)

process.stdout.write(`\n${report}\n`)
if (out !== "") {
	writeFileSync(
		out,
		JSON.stringify({ environment, rate, throughputRuns, latencyRuns, restartRuns }, null, 2),
	)
	process.stderr.write(`raw runs written to ${out}\n`)
}
