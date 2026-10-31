// Fresh-process desktop V8 proxy of maple-ai's cold path. CPU includes runtime/GC work, no I/O.
// Run from the repo root: bun apps/ai/scripts/cold-path/measure.mjs <PROBE=1 bundle> [runs]
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const [dir, count = "11"] = process.argv.slice(2)
if (!dir) throw new Error("Expected bundle directory")
if (process.env.MAPLE_CPU_PROBE_CHILD === "1") {
	globalThis.caches = { default: {} }
	globalThis.HTMLRewriter = class {}
	globalThis.fetch = async () => {
		throw new Error("External I/O is forbidden in the CPU probe")
	}
	const base = pathToFileURL(resolve(dir) + "/")
	const results = {}
	const measure = async (name, action) => {
		const cpu = process.cpuUsage()
		const wall = performance.now()
		const value = await action()
		const used = process.cpuUsage(cpu)
		results[name] = { wallMs: performance.now() - wall, cpuMs: (used.user + used.system) / 1000 }
		return value
	}
	await measure("startup", () => import(new URL("worker.js", base)))
	const probe = await measure("probeImport", () => import(new URL("probe.js", base)))
	await measure("routeGraph", () => probe.build("mcp"))
	await measure("toolGraph", () => probe.buildTools())
	console.log("MEASUREMENT " + JSON.stringify(results))
} else {
	const runs = Array.from({ length: Number(count) }, () => {
		const child = spawnSync(
			"node",
			[
				"--no-warnings",
				"--loader",
				"./apps/api/scripts/cold-path/cf-loader.mjs",
				import.meta.filename,
				dir,
			],
			{ encoding: "utf8", env: { ...process.env, MAPLE_CPU_PROBE_CHILD: "1" } },
		)
		const line = child.stdout.split("\n").find((l) => l.startsWith("MEASUREMENT "))
		if (child.status !== 0 || !line) throw new Error(child.stderr || child.stdout)
		return JSON.parse(line.slice(12))
	})
	const median = (xs) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]
	const keys = Object.keys(runs[0])
	const summary = Object.fromEntries(
		keys.map((key) => [
			key,
			{ wallMs: median(runs.map((r) => r[key].wallMs)), cpuMs: median(runs.map((r) => r[key].cpuMs)) },
		]),
	)
	console.log(
		JSON.stringify(
			{
				engine: spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim(),
				runs: runs.length,
				median: summary,
			},
			null,
			2,
		),
	)
}
