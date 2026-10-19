import { type Browser, chromium, devices, type Page } from "playwright"
import { PORT_BASE } from "../config.ts"
import { loadBuild, serveStatic } from "../serve.ts"

/**
 * `apps/web/perf/logs.perf.spec.ts` and `logs-hover.spec.ts`, run against static parity builds of
 * both apps (`/lab/bench/logs`), N times each. Records what the specs measure (mounted rows, the
 * harness scroll: frames, frame p95, long tasks, blocking time, commits) plus CDP script, layout
 * and style time over the scroll, JS heap after GC, time to first rows, hover-card latency over its
 * 300ms rest delay, frame cost of a chip sweep, and the hover spec's three behaviours.
 *
 *   bun run src/bench/logs.ts [--runs 5] [--builds legacy-head,foldkit] [--serve]
 *
 * `--serve` only serves the builds (legacy-head on base+5, foldkit on base+6) so the original
 * Playwright specs can run against them: `PERF_BASE_URL=http://127.0.0.1:<port> bunx playwright test`.
 */
const args = process.argv.slice(2)
const option = (name: string, fallback: string) => {
	const at = args.indexOf(`--${name}`)
	return at === -1 ? fallback : (args[at + 1] ?? fallback)
}
const RUNS = Number(option("runs", "5"))
const BUILDS = option("builds", "legacy-head,foldkit").split(",")
const PORTS = new Map([
	["legacy-head", PORT_BASE + 5],
	["foldkit", PORT_BASE + 6],
])
const portOf = (name: string) => PORTS.get(name) ?? PORT_BASE + 7
const CARD = '[data-slot="hover-card-content"]'

interface BenchHarness {
	ready: boolean
	runScroll: () => Promise<Record<string, number>>
}
interface FrameSampler {
	frames: Array<number>
	previous: number
	running: boolean
}
interface HoverProbe {
	entered: number
	inserted: number
	painted: number
	inFrame: boolean
	sampling: boolean
}
declare global {
	interface Window {
		__logsBench?: BenchHarness
		__frames?: FrameSampler
		__hover?: HoverProbe
	}
}

type Sample = Record<string, number>

const cdpMetrics = async (page: Page) => {
	const session = await page.context().newCDPSession(page)
	await session.send("Performance.enable")
	return async (): Promise<Sample> => {
		const { metrics } = await session.send("Performance.getMetrics")
		return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]))
	}
}

const collectGarbage = async (page: Page) => {
	const session = await page.context().newCDPSession(page)
	await session.send("HeapProfiler.collectGarbage")
	await session.detach()
}

const chipCentres = (page: Page) =>
	page.evaluate(() =>
		Array.from(document.querySelectorAll('[role="log"] button[aria-label^="Copy "][aria-label*="="]'))
			.filter((chip) => {
				const lane = chip.parentElement?.getBoundingClientRect()
				const r = chip.getBoundingClientRect()
				return (
					lane !== undefined &&
					r.top >= lane.top &&
					r.bottom <= lane.bottom &&
					r.right <= lane.right + 1
				)
			})
			.map((chip) => {
				const r = chip.getBoundingClientRect()
				return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
			})
			.filter((p) => p.x > 0 && p.x < window.innerWidth && p.y > 0 && p.y < window.innerHeight)
			.sort((a, b) => a.y - b.y),
	)

const open = async (browser: Browser, port: number) => {
	const context = await browser.newContext({
		...devices["Desktop Chrome"],
		viewport: { width: 1440, height: 900 },
	})
	const page = await context.newPage()
	const errors: Array<string> = []
	page.on("pageerror", (error) => errors.push(error.message))
	await page.goto(`http://127.0.0.1:${port}/lab/bench/logs`)
	await page.waitForFunction(() => window.__logsBench?.ready === true, undefined, { timeout: 30_000 })
	const readyMs = await page.evaluate(() => performance.now())
	return { context, page, errors, readyMs }
}

/** Starts sampling rAF intervals in the page; the returned function stops and summarises them. */
const sampleFrames = async (page: Page) => {
	await page.evaluate(() => {
		const state = { frames: [] as Array<number>, previous: performance.now(), running: true }
		window.__frames = state
		const tick = (now: number) => {
			state.frames.push(now - state.previous)
			state.previous = now
			if (state.running) requestAnimationFrame(tick)
		}
		requestAnimationFrame(tick)
	})
	return () =>
		page.evaluate(() => {
			const state = window.__frames
			if (state !== undefined) state.running = false
			const sorted = [...(state?.frames ?? [])].sort((a, b) => a - b)
			return {
				p95: sorted[Math.round(0.95 * (sorted.length - 1))] ?? 0,
				max: sorted.at(-1) ?? 0,
				over20: sorted.filter((ms) => ms > 20).length,
			}
		})
}

/**
 * From the pointer entering a chip to its card, minus the 300ms rest delay: when the card node is
 * inserted, and when the frame showing it has painted. React commits from the timer task, Foldkit
 * patches in the next animation frame; both reach the screen in the same paint, so the paint time
 * (a MessageChannel task after the frame that holds the insertion) is the comparable number.
 */
const hoverLatency = async (page: Page, point: { x: number; y: number }) => {
	await page.evaluate(() => {
		const state = { entered: 0, inserted: 0, painted: 0, inFrame: false, sampling: true }
		window.__hover = state
		const afterPaint = (record: () => void) => {
			const channel = new MessageChannel()
			channel.port1.onmessage = record
			channel.port2.postMessage(null)
		}
		// Registered first every frame, so it marks the rAF phase before any app callback runs.
		const frame = () => {
			state.inFrame = true
			afterPaint(() => (state.inFrame = false))
			if (state.sampling) requestAnimationFrame(frame)
		}
		requestAnimationFrame(frame)
		document.addEventListener("pointerover", (event) => (state.entered ||= event.timeStamp), {
			once: true,
		})
		const observer = new MutationObserver(() => {
			if (state.inserted !== 0 || document.querySelector('[data-slot="hover-card-content"]') === null)
				return
			state.inserted = performance.now()
			const record = () => {
				state.painted = performance.now()
				state.sampling = false
			}
			if (state.inFrame) afterPaint(record)
			else requestAnimationFrame(() => afterPaint(record))
			observer.disconnect()
		})
		observer.observe(document.body, { childList: true, subtree: true })
	})
	await page.mouse.move(point.x, point.y)
	await page.locator(CARD).waitFor({ timeout: 5_000 })
	await page.waitForTimeout(100)
	return page.evaluate(() => {
		const state = window.__hover ?? { entered: 0, inserted: Number.NaN, painted: Number.NaN }
		return {
			inserted: state.inserted - state.entered - 300,
			painted: state.painted - state.entered - 300,
		}
	})
}

const runOnce = async (browser: Browser, port: number): Promise<Sample> => {
	const { context, page, errors, readyMs } = await open(browser, port)
	const metrics = await cdpMetrics(page)
	await collectGarbage(page)
	const heapLoaded = (await metrics()).JSHeapUsedSize ?? 0
	const mountedBefore = await page.locator("[role='log'] > [data-index]").count()
	const before = await metrics()
	const scroll = await page.evaluate(
		() => window.__logsBench?.runScroll() ?? Promise.reject(new Error("no __logsBench harness")),
	)
	const after = await metrics()
	const mountedAfter = await page.locator("[role='log'] > [data-index]").count()
	await collectGarbage(page)
	const heapScrolled = (await metrics()).JSHeapUsedSize ?? 0

	// Back to the top for the hover spec, which reads the first screen of chips.
	await page.evaluate(() => document.querySelector("[role='log']")?.parentElement?.scrollTo({ top: 0 }))
	await page.waitForTimeout(300)
	const centres = await chipCentres(page)
	const stopSweep = await sampleFrames(page)
	for (const point of centres) await page.mouse.move(point.x, point.y, { steps: 4 })
	await page.mouse.move(20, 20)
	const sweep = await stopSweep()
	await page.waitForTimeout(1_200)
	const strandedAfterSweep = await page.locator(CARD).count()
	const first = centres[0]
	if (first === undefined) throw new Error("no chip in the bench viewport")
	const latency = await hoverLatency(page, first)
	const cardsOnRest = await page.locator(CARD).count()
	await page.mouse.move(20, 20)
	await page.locator(CARD).waitFor({ state: "detached", timeout: 5_000 })
	await context.close()
	const delta = (name: string) => ((after[name] ?? 0) - (before[name] ?? 0)) * 1000
	return {
		readyMs,
		mountedBefore,
		mountedAfter,
		frames: scroll.frames ?? 0,
		frameP95Ms: scroll.frameP95Ms ?? 0,
		longTasks: scroll.longTasks ?? 0,
		totalBlockingMs: scroll.totalBlockingMs ?? 0,
		commits: scroll.reactCommits ?? 0,
		scrollScriptMs: delta("ScriptDuration"),
		scrollLayoutMs: delta("LayoutDuration"),
		scrollStyleMs: delta("RecalcStyleDuration"),
		scrollTaskMs: delta("TaskDuration"),
		heapLoadedMb: heapLoaded / 2 ** 20,
		heapScrolledMb: heapScrolled / 2 ** 20,
		sweepFrameP95Ms: sweep.p95,
		sweepFramesOver20: sweep.over20,
		hoverInsertMs: latency.inserted,
		hoverPaintMs: latency.painted,
		strandedAfterSweep,
		cardsOnRest,
		pageErrors: errors.length,
	}
}

const percentile = (values: ReadonlyArray<number>, p: number) => {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.round((p / 100) * (sorted.length - 1))] ?? 0
}

const servers = BUILDS.map((name) => serveStatic(loadBuild(name), portOf(name), ""))
if (args.includes("--serve")) {
	for (const name of BUILDS) console.log(`[bench] ${name}: http://127.0.0.1:${portOf(name)}/lab/bench/logs`)
} else {
	const browser = await chromium.launch()
	const results = new Map(BUILDS.map((name) => [name, [] as Array<Sample>]))
	// Interleaved, so machine noise lands on both apps alike.
	for (let run = 0; run < RUNS; run++)
		for (const name of BUILDS) {
			const sample = await runOnce(browser, portOf(name))
			results.get(name)?.push(sample)
			console.log(`[bench] ${name} run ${run + 1}: ${JSON.stringify(sample)}`)
		}
	await browser.close()
	const keys = Object.keys(results.get(BUILDS[0] ?? "")?.[0] ?? {})
	const header = `| metric | ${BUILDS.map((name) => `${name} p50 | ${name} p95`).join(" | ")} |`
	console.log(`\n${header}\n|---|${BUILDS.map(() => "---|---").join("|")}|`)
	for (const key of keys) {
		const cells = BUILDS.map((name) => {
			const values = (results.get(name) ?? []).map((sample) => sample[key] ?? 0)
			return `${percentile(values, 50).toFixed(1)} | ${percentile(values, 95).toFixed(1)}`
		})
		console.log(`| ${key} | ${cells.join(" | ")} |`)
	}
	for (const server of servers) server.stop(true)
}
