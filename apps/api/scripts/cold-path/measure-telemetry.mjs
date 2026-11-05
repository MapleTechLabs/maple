// Run in Node against the same compiled SDK source for each candidate.
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
const { prepare } = await import(pathToFileURL(resolve(process.argv[2], "telemetry.js")))
const runs = []
for (let i = 0; i < 9; i++) {
	const exported = []
	globalThis.fetch = async (_url, init) => {
		exported.push(init.body)
		return new Response(null, { status: 200 })
	}
	const flush = await prepare()
	const cpu = process.cpuUsage()
	const start = performance.now()
	await flush()
	const used = process.cpuUsage(cpu)
	runs.push({
		wallMs: performance.now() - start,
		cpuMs: (used.user + used.system) / 1000,
		posts: exported.length,
	})
	const spans = exported
		.flatMap((body) => JSON.parse(body).resourceSpans ?? [])
		.flatMap((r) => r.scopeSpans)
		.flatMap((s) => s.spans)
	if (spans.length !== 200 || new Set(spans.map((s) => s.name)).size !== 200)
		throw new Error("Lost or duplicated spans")
}
const median = (key) => runs.map((r) => r[key]).sort((a, b) => a - b)[4]
console.log(
	JSON.stringify(
		{ runs, median: { wallMs: median("wallMs"), cpuMs: median("cpuMs"), posts: median("posts") } },
		null,
		2,
	),
)
