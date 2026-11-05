// Fresh-process desktop V8 proxy. CPU includes runtime/GC work, not remote I/O.
// Run from repo root with Bun: bun apps/api/scripts/cold-path/measure.mjs <bundle> <output.json> [runs]
import { spawnSync } from "node:child_process"
import { readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const [dir, output, count = "9", graph = "full"] = process.argv.slice(2)
if (!Number.isInteger(Number(count)) || Number(count) < 1) throw new Error("runs must be a positive integer")
if (graph !== "full" && graph !== "query") throw new Error("graph must be full or query")
if (!dir) throw new Error("Expected bundle directory")
if (process.env.MAPLE_CPU_PROBE_CHILD === "1") {
	globalThis.caches = { default: {} }
	globalThis.HTMLRewriter = class {}
	globalThis.fetch = async () => {
		throw new Error("External I/O is forbidden in the CPU probe")
	}
	const base = pathToFileURL(resolve(dir) + "/")
	const results = {}
	async function measure(name, action) {
		const cpu = process.cpuUsage()
		const wall = performance.now()
		await action()
		const used = process.cpuUsage(cpu)
		results[name] = { wallMs: performance.now() - wall, cpuMs: (used.user + used.system) / 1000 }
	}
	try {
		await measure("startup", () => import(new URL("worker.js", base)))
		let probe
		await measure("probeImport", async () => {
			probe = await import(new URL("probe.js", base))
		})
		await measure("httpImport", async () => {
			const graphs = readdirSync(dir).filter((f) =>
				(graph === "query"
					? /^query-http-graph-.*\.js$/
					: /^(http-graph|service-graph)-.*\.js$/
				).test(f),
			)
			if (graphs.length !== (graph === "query" ? 1 : 2))
				throw new Error(`Expected both HTTP graph chunks, found ${graphs.length}`)
			await Promise.all(graphs.map((f) => import(new URL(f, base))))
		})
		await measure("graphBuild", () => probe.build(graph))
		const warm = await probe.prepareWarm(graph)
		for (let i = 0; i < 1000; i++) await warm()
		await measure("warm10000", async () => {
			for (let i = 0; i < 10000; i++) await warm()
		})
		console.log("MEASUREMENT " + JSON.stringify(results))
	} catch (error) {
		console.error(String(error))
		process.exitCode = 1
	}
} else {
	const runs = []
	for (let i = 0; i < Number(count); i++) {
		const child = spawnSync(
			"node",
			[
				"--no-warnings",
				"--loader",
				"./apps/api/scripts/cold-path/cf-loader.mjs",
				import.meta.filename,
				dir,
				"",
				"1",
				graph,
			],
			{
				encoding: "utf8",
				env: { ...process.env, MAPLE_CPU_PROBE_CHILD: "1" },
			},
		)
		if (child.status !== 0) throw new Error(child.stderr || child.stdout)
		const line = child.stdout.split("\n").find((l) => l.startsWith("MEASUREMENT "))
		if (!line) throw new Error("Child did not produce a measurement")
		runs.push(JSON.parse(line.slice(12)))
	}
	const median = (xs) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]
	const summary = Object.fromEntries(
		Object.keys(runs[0]).map((key) => [
			key,
			{
				wallMs: median(runs.map((r) => r[key].wallMs)),
				cpuMs: median(runs.map((r) => r[key].cpuMs)),
			},
		]),
	)
	summary.total = {
		wallMs: median(
			runs.map((r) =>
				Object.entries(r)
					.filter(([key]) => key !== "warm10000")
					.map(([, value]) => value)
					.reduce((s, v) => s + v.wallMs, 0),
			),
		),
		cpuMs: median(
			runs.map((r) =>
				Object.entries(r)
					.filter(([key]) => key !== "warm10000")
					.map(([, value]) => value)
					.reduce((s, v) => s + v.cpuMs, 0),
			),
		),
	}
	const result = {
		engine: spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim(),
		kind: "offline-desktop-v8",
		runs,
		median: summary,
	}
	if (output) writeFileSync(output, JSON.stringify(result, null, 2) + "\n")
	console.log(JSON.stringify(summary, null, 2))
}
