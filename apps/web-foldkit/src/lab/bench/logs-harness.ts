/**
 * `window.__logsBench` for `perf/logs.perf.spec.ts`: a 121-step scroll, frame and long-task
 * sampling. `reactCommits` counts DOM commits (mutation batches under the stream) and
 * `reactDurationMs` stays 0; script time comes from the CDP metrics the perf runner records.
 */
export interface LogsBenchMetrics {
	readonly frames: number
	readonly frameP95Ms: number
	readonly longTasks: number
	readonly totalBlockingMs: number
	readonly reactCommits: number
	readonly reactDurationMs: number
}

export interface LogsBenchHarness {
	ready: boolean
	readonly runScroll: () => Promise<LogsBenchMetrics>
}

declare global {
	interface Window {
		__logsBench?: LogsBenchHarness
	}
}

const SCROLL_STEPS = 120

const percentile = (values: ReadonlyArray<number>, p: number): number => {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))] ?? 0
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

const scrollThrough = (scroller: HTMLElement, maxScroll: number, step: number): Promise<void> => {
	if (step > SCROLL_STEPS) return Promise.resolve()
	scroller.scrollTop = maxScroll * (step / SCROLL_STEPS)
	return nextFrame().then(() => scrollThrough(scroller, maxScroll, step + 1))
}

const runScroll = (root: HTMLElement): Promise<LogsBenchMetrics> => {
	const log = root.querySelector<HTMLElement>("[role='log']")
	const scroller = log?.parentElement
	if (log === null || scroller == null)
		return Promise.reject(new Error("Logs benchmark scroller not found"))
	const frames: Array<number> = []
	const longTasks: Array<PerformanceEntry> = []
	const commits = { count: 0 }
	const sampling = { previous: performance.now(), handle: 0, running: true }
	const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries()))
	observer.observe({ entryTypes: ["longtask"] })
	const mutations = new MutationObserver(() => {
		commits.count++
	})
	mutations.observe(log, { childList: true, subtree: true, attributes: true, characterData: true })
	const sample = (now: number) => {
		frames.push(now - sampling.previous)
		sampling.previous = now
		if (sampling.running) sampling.handle = requestAnimationFrame(sample)
	}
	sampling.handle = requestAnimationFrame(sample)
	const maxScroll = scroller.scrollHeight - scroller.clientHeight
	return scrollThrough(scroller, maxScroll, 0)
		.then(nextFrame)
		.then(nextFrame)
		.then(() => {
			sampling.running = false
			cancelAnimationFrame(sampling.handle)
			observer.disconnect()
			mutations.disconnect()
			return {
				frames: frames.length,
				frameP95Ms: percentile(frames, 95),
				longTasks: longTasks.length,
				totalBlockingMs: longTasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0),
				reactCommits: commits.count,
				reactDurationMs: 0,
			}
		})
}

/** Installs the harness for the bench root; `ready` flips once the first rows are on screen. */
export const installLogsBench = (root: HTMLElement): (() => void) => {
	const harness: LogsBenchHarness = { ready: false, runScroll: () => runScroll(root) }
	window.__logsBench = harness
	const state = { handle: 0 }
	const waitForRows = () => {
		harness.ready = root.querySelector("[role='log'] > [data-index]") !== null
		if (!harness.ready) state.handle = requestAnimationFrame(waitForRows)
	}
	state.handle = requestAnimationFrame(waitForRows)
	return () => {
		cancelAnimationFrame(state.handle)
		if (window.__logsBench === harness) delete window.__logsBench
	}
}
