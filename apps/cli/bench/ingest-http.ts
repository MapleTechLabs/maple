// End-to-end ingest latency against a real `maple start --in-memory`: time from
// POST to 2xx for a matrix of signal × records per export × concurrent exports.
//
//   bun run bench:ingest [--signals traces,logs,metrics] [--sizes 1,50,500]
//     [--concurrency 1,5,10] [--exports 40] [--warmup 5] [--burn 0] [--out <file>]
//
// `--burn N` keeps N cores busy to reproduce a loaded dev machine.

import { openSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { type Signal, exportBody } from "./payloads"
import { burnCpu, environment, flag, list, numbers, summarize, type Summary, writeReport } from "./report"

const signals = list("signals", "traces,logs,metrics") as Signal[]
const sizes = numbers("sizes", "1,50,500")
const concurrencies = numbers("concurrency", "1,5,10")
const exportsPerCell = Number(flag("exports", "40"))
const warmup = Number(flag("warmup", "5"))
const burn = Number(flag("burn", "0"))

const freePort = (): number => {
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
	const port = probe.port
	probe.stop(true)
	return port
}

const waitHealthy = async (origin: string, deadline: number): Promise<void> => {
	const ok = await fetch(`${origin}/health`).then(
		(r) => r.ok,
		() => false,
	)
	if (ok) return
	if (Date.now() > deadline) throw new Error(`server at ${origin} never became healthy`)
	await Bun.sleep(100)
	return waitHealthy(origin, deadline)
}

/** Requests slower than this are listed with their offset from server start. */
const STALL_MS = 1_000
const stalls: Array<{ readonly signal: Signal; readonly atSeconds: number; readonly ms: number }> = []
let bootedAt = 0

const post = async (origin: string, signal: Signal, body: string): Promise<number> => {
	const started = performance.now()
	const response = await fetch(`${origin}/v1/${signal}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	})
	await response.text()
	if (!response.ok) throw new Error(`POST /v1/${signal}: HTTP ${response.status}`)
	const ms = performance.now() - started
	if (ms > STALL_MS && bootedAt > 0)
		stalls.push({ signal, atSeconds: Math.round((started - bootedAt) / 100) / 10, ms: Math.round(ms) })
	return ms
}

interface Cell {
	readonly signal: Signal
	readonly records: number
	readonly concurrency: number
	readonly latencyMs: Summary
	readonly recordsPerSecond: number
}

const runCell = async (
	origin: string,
	signal: Signal,
	records: number,
	concurrency: number,
): Promise<Cell> => {
	const wave = (n: number) =>
		Promise.all(Array.from({ length: n }, () => post(origin, signal, exportBody(signal, records))))
	await wave(Math.max(warmup, concurrency))
	const waves = Math.max(1, Math.ceil(exportsPerCell / concurrency))
	const samples: number[] = []
	const started = performance.now()
	for (let i = 0; i < waves; i++) samples.push(...(await wave(concurrency)))
	const elapsed = (performance.now() - started) / 1000
	return {
		signal,
		records,
		concurrency,
		latencyMs: summarize(samples),
		recordsPerSecond: Math.round((samples.length * records) / elapsed),
	}
}

const main = async () => {
	const port = freePort()
	const origin = `http://127.0.0.1:${port}`
	const logPath = join(tmpdir(), `maple-bench-server-${port}.log`)
	const log = openSync(logPath, "w")
	const server = Bun.spawn(["bun", "run", "src/bin.ts", "start", "--in-memory", "--port", String(port)], {
		cwd: resolve(import.meta.dir, ".."),
		stdout: log,
		stderr: log,
		env: { ...process.env, MAPLE_NO_UPDATE_CHECK: "1" },
	})
	const stopBurn = burnCpu(burn)
	const env = environment()
	const stop = async () => {
		stopBurn()
		server.kill("SIGINT")
		await server.exited
	}

	const run = async () => {
		const bootStarted = performance.now()
		const died = server.exited.then((code) => {
			throw new Error(`server exited with ${code} before becoming healthy; see ${logPath}`)
		})
		await Promise.race([waitHealthy(origin, Date.now() + 120_000), died])
		const bootMs = Math.round(performance.now() - bootStarted)
		bootedAt = performance.now()
		const firstExportMs = Math.round(await post(origin, "traces", exportBody("traces", 1)))
		console.log(
			`server healthy in ${bootMs} ms, first traces export ${firstExportMs} ms (log: ${logPath})`,
		)

		const cells: Cell[] = []
		for (const signal of signals)
			for (const records of sizes)
				for (const concurrency of concurrencies) {
					const cell = await runCell(origin, signal, records, concurrency)
					cells.push(cell)
					const { p50, p95, max } = cell.latencyMs
					console.log(
						`${signal.padEnd(7)} ${String(records).padStart(4)}/export x${String(concurrency).padEnd(3)} ` +
							`p50 ${p50.toFixed(1).padStart(7)} ms  p95 ${p95.toFixed(1).padStart(7)} ms  ` +
							`max ${max.toFixed(1).padStart(7)} ms  ${String(cell.recordsPerSecond).padStart(7)} rec/s`,
					)
				}
		stalls.forEach((s) => console.log(`stall: ${s.signal} request at +${s.atSeconds}s took ${s.ms} ms`))
		return { bootMs, firstExportMs, cells, stalls }
	}

	const result = await run().finally(stop)
	const out = writeReport(`local-ingest-http-${env.date.slice(0, 10)}.json`, {
		bench: "local-ingest-http",
		environment: env,
		options: { signals, sizes, concurrencies, exportsPerCell, warmup, burn },
		...result,
	})
	console.log(`wrote ${out}`)
}

await main()
