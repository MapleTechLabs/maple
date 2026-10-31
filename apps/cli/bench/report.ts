import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { cpus, loadavg, platform, release, totalmem } from "node:os"
import { dirname, resolve } from "node:path"

export interface Summary {
	readonly n: number
	readonly p50: number
	readonly p95: number
	readonly max: number
	readonly mean: number
}

const round = (ms: number) => Math.round(ms * 100) / 100

export const summarize = (samples: ReadonlyArray<number>): Summary => {
	const sorted = [...samples].sort((a, b) => a - b)
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
	return {
		n: sorted.length,
		p50: round(at(0.5)),
		p95: round(at(0.95)),
		max: round(sorted.at(-1) ?? 0),
		mean: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)),
	}
}

const gitSha = (): string =>
	execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()

export const environment = () => ({
	date: new Date().toISOString(),
	git: gitSha(),
	bun: Bun.version,
	platform: `${platform()} ${release()}`,
	cpu: cpus()[0]?.model ?? "unknown",
	cores: cpus().length,
	memoryGb: Math.round(totalmem() / 2 ** 30),
	loadavgAtStart: loadavg().map((l) => Math.round(l * 100) / 100),
})

/** `--name value` / `--flag` argv parsing with defaults. */
export const flag = (name: string, fallback: string): string => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback
}
export const list = (name: string, fallback: string): string[] =>
	flag(name, fallback).split(",").filter(Boolean)
export const numbers = (name: string, fallback: string): number[] => list(name, fallback).map(Number)

/** Write the JSON report under `docs/benchmarks/` (or `--out`). */
export const writeReport = (defaultName: string, report: unknown): string => {
	const out = resolve(flag("out", resolve(import.meta.dir, "../../../docs/benchmarks", defaultName)))
	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, `${JSON.stringify(report, null, "\t")}\n`)
	return out
}

/** Spawn `n` busy-looping workers to simulate a loaded dev machine. */
export const burnCpu = (n: number): (() => void) => {
	const workers = Array.from({ length: n }, () =>
		Bun.spawn(["bun", "-e", "for(;;){}"], { stdout: "ignore", stderr: "ignore" }),
	)
	return () => workers.forEach((w) => w.kill())
}
