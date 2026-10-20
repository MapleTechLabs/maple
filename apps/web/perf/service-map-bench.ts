import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, join, resolve } from "node:path"
import { chromium, type Page } from "playwright"

/**
 * The measurements of apps/web/perf/service-map.perf.spec.ts (readiness, idle, pan and fit-all
 * frame timing at 120 services / 400 edges) against static parity builds of both apps.
 * Run: `bun apps/web/perf/service-map-bench.ts [--runs 5] [--base 5290]`, after
 * `parity build legacy-head` and `parity build foldkit` with the same PARITY_PORT_BASE.
 */

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
	const index = args.indexOf(`--${name}`)
	return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}
const RUNS = Number(flag("runs", "5"))
const BASE = flag("base", "5290")
const BENCH = "/lab/bench/service-map?services=120&edges=400&rps=high&seed=1"
const root = resolve(import.meta.dirname, "../../..")
const builds = { legacy: "legacy-head", foldkit: "foldkit" } as const

const TYPES = new Map([
	[".html", "text/html"],
	[".js", "text/javascript"],
	[".css", "text/css"],
	[".woff2", "font/woff2"],
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
	[".json", "application/json"],
])

/** SPA static server over one build directory. */
const serve = (dir: string, port: number) =>
	Bun.serve({
		port,
		fetch: (request) => {
			const path = join(dir, decodeURIComponent(new URL(request.url).pathname))
			const file = existsSync(path) && statSync(path).isFile() ? path : join(dir, "index.html")
			return new Response(readFileSync(file), {
				headers: { "content-type": TYPES.get(extname(file)) ?? "application/octet-stream" },
			})
		},
	})

interface Frames {
	readonly fps: number
	readonly frameP50: number
	readonly frameP95: number
	readonly longTasks: number
	readonly totalBlockingMs: number
}

interface Milestones {
	firstMap?: number
	elkReady?: number
}

/** Navigation-relative milestones: first map paint (the 2 s fallback layout) and ELK's final layout. */
const recordMilestones = () => {
	const marks: Milestones = {}
	window.__s5Marks = marks
	new MutationObserver(() => {
		if (marks.firstMap === undefined && document.querySelector(".react-flow__edge"))
			marks.firstMap = performance.now()
		if (marks.elkReady === undefined && document.querySelector('[data-elk-status="ready"]'))
			marks.elkReady = performance.now()
	}).observe(document, { subtree: true, childList: true, attributes: true })
}

const measure = async (page: Page, url: string) => {
	await page.addInitScript(recordMilestones)
	await page.goto(url)
	await page.waitForFunction(() => window.__smBench?.ready === true, undefined, { timeout: 90_000 })
	const readyMs = await page.evaluate(() => window.__s5Marks?.elkReady ?? -1)
	const firstMapMs = await page.evaluate(() => window.__s5Marks?.firstMap ?? -1)
	await page.evaluate(async () => {
		window.__smBench?.setCamera({ x: 0, y: 0, zoom: 1 })
		await window.__smBench?.waitForQuiet()
	})
	const idle = await page.evaluate(() => window.__smBench?.run({ durationMs: 4000, pan: false }))
	const pan = await page.evaluate(() => window.__smBench?.run({ durationMs: 4000, pan: true }))
	const fitAll = await page.evaluate(async () => {
		window.__smBench?.fitCamera()
		await new Promise((done) => setTimeout(done, 300))
		return await window.__smBench?.run({ durationMs: 2000, pan: false })
	})
	return { readyMs, firstMapMs, idle, pan, fitAll }
}

type Sample = Awaited<ReturnType<typeof measure>>

const pct = (values: ReadonlyArray<number>, p: number) => {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]
}

const summarize = (samples: ReadonlyArray<Sample>) => {
	const rows = {
		"first map ms": samples.map((s) => s.firstMapMs),
		"ELK ready ms": samples.map((s) => s.readyMs),
		"idle fps": samples.map((s) => s.idle?.fps ?? Number.NaN),
		"idle frame p50": samples.map((s) => s.idle?.frameP50 ?? Number.NaN),
		"idle frame p95": samples.map((s) => s.idle?.frameP95 ?? Number.NaN),
		"idle TBT ms": samples.map((s) => s.idle?.totalBlockingMs ?? Number.NaN),
		"pan fps": samples.map((s) => s.pan?.fps ?? Number.NaN),
		"pan frame p50": samples.map((s) => s.pan?.frameP50 ?? Number.NaN),
		"pan frame p95": samples.map((s) => s.pan?.frameP95 ?? Number.NaN),
		"pan TBT ms": samples.map((s) => s.pan?.totalBlockingMs ?? Number.NaN),
		"pan long tasks": samples.map((s) => s.pan?.longTasks ?? Number.NaN),
		"fit-all fps": samples.map((s) => s.fitAll?.fps ?? Number.NaN),
		"fit-all frame p95": samples.map((s) => s.fitAll?.frameP95 ?? Number.NaN),
	}
	return Object.fromEntries(
		Object.entries(rows).map(([key, values]) => [
			key,
			{ p50: +pct(values, 50).toFixed(1), p95: +pct(values, 95).toFixed(1) },
		]),
	)
}

const browser = await chromium.launch()
const results: Record<string, unknown> = {}
for (const [label, build] of Object.entries(builds)) {
	const port = 5600 + Object.keys(results).length
	const server = serve(join(root, `packages/ui-parity/.parity/builds-${BASE}/${build}`), port)
	const samples: Sample[] = []
	for (let run = 0; run < RUNS; run++) {
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			deviceScaleFactor: 1,
			reducedMotion: "no-preference",
		})
		const page = await context.newPage()
		samples.push(await measure(page, `http://127.0.0.1:${port}${BENCH}`))
		await context.close()
		console.error(`[perf] ${label} run ${run + 1}/${RUNS}: ready ${samples.at(-1)?.readyMs}ms`)
	}
	server.stop(true)
	results[label] = { samples, summary: summarize(samples) }
}
await browser.close()
console.log(JSON.stringify(results, null, 2))

declare global {
	interface Window {
		__s5Marks?: Milestones
		__smBench?: {
			ready: boolean
			readyMs: number | null
			run: (options?: { durationMs?: number; pan?: boolean }) => Promise<Frames>
			setCamera: (viewport: { x: number; y: number; zoom: number }) => void
			fitCamera: () => void
			waitForQuiet: (options?: { maxMs?: number; quietMs?: number }) => Promise<boolean>
		}
	}
}
