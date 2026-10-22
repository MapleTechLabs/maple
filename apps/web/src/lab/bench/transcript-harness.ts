/**
 * `window.__transcriptBench` for `perf/agent-transcript.perf.spec.ts`: a sweep of the page
 * scroller, one frame per step, frame and long-task sampling and the DOM the mounted rows hold.
 * `reactCommits` counts DOM commits under the list, the durations stay 0.
 */
export interface TranscriptBenchMetrics {
	readonly frames: number
	readonly frameP95Ms: number
	readonly droppedFrames: number
	readonly longTasks: number
	readonly totalBlockingMs: number
	readonly reactCommits: number
	readonly reactDurationMs: number
	readonly reactMaxCommitMs: number
	readonly mountedRows: number
	readonly listNodes: number
	readonly maxRowNodes: number
}

type DomCounts = Pick<TranscriptBenchMetrics, "mountedRows" | "listNodes" | "maxRowNodes">

export interface TranscriptBenchHarness {
	ready: boolean
	mountCommitMs: number
	readonly runScroll: (steps?: number) => Promise<TranscriptBenchMetrics>
	readonly countDom: () => DomCounts
}

declare global {
	interface Window {
		__transcriptBench?: TranscriptBenchHarness
	}
}

/** The virtualizer's row wrappers, by slot: the tab panel around the list carries `data-index` too. */
const LIST_SELECTOR = '[data-transcript-bench] [data-slot="transcript-row"]'
const SCROLLER_SELECTOR = '[data-transcript-bench] [data-slot="page-scroll-area"]'
const FRAME_MS = 1000 / 60

const percentile = (values: ReadonlyArray<number>, p: number): number => {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))] ?? 0
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

const countDom = (): DomCounts => {
	const sizes = Array.from(document.querySelectorAll(LIST_SELECTOR)).map(
		(row) => row.querySelectorAll("*").length,
	)
	return {
		mountedRows: sizes.length,
		listNodes: sizes.reduce((sum, size) => sum + size, 0),
		maxRowNodes: sizes.reduce((max, size) => Math.max(max, size), 0),
	}
}

/** Re-reads the extent every step: measured rows grow the list as the sweep goes. */
const sweep = (scroller: HTMLElement, steps: number, step: number): Promise<void> => {
	if (step > steps) return Promise.resolve()
	scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * (step / steps)
	return nextFrame().then(() => sweep(scroller, steps, step + 1))
}

const runScroll = (steps: number): Promise<TranscriptBenchMetrics> => {
	const scroller = document.querySelector<HTMLElement>(SCROLLER_SELECTOR)
	if (scroller === null) return Promise.reject(new Error("Transcript benchmark scroller not found"))
	const frames: Array<number> = []
	const longTasks: Array<PerformanceEntry> = []
	const commits = { count: 0 }
	const sampling = { previous: performance.now(), handle: 0, running: true }
	// Firefox and WebKit expose no Long Tasks; the frame and DOM metrics stay valid there.
	const observer = PerformanceObserver.supportedEntryTypes.includes("longtask")
		? new PerformanceObserver((list) => longTasks.push(...list.getEntries()))
		: undefined
	observer?.observe({ entryTypes: ["longtask"] })
	const mutations = new MutationObserver(() => {
		commits.count++
	})
	mutations.observe(scroller, { childList: true, subtree: true })
	const sample = (now: number) => {
		frames.push(now - sampling.previous)
		sampling.previous = now
		if (sampling.running) sampling.handle = requestAnimationFrame(sample)
	}
	sampling.handle = requestAnimationFrame(sample)
	return sweep(scroller, steps, 0)
		.then(nextFrame)
		.then(nextFrame)
		.then(() => {
			sampling.running = false
			cancelAnimationFrame(sampling.handle)
			observer?.disconnect()
			mutations.disconnect()
			return {
				frames: frames.length,
				frameP95Ms: percentile(frames, 95),
				droppedFrames: frames.filter((duration) => duration > FRAME_MS * 1.5).length,
				longTasks: longTasks.length,
				totalBlockingMs: longTasks.reduce((sum, entry) => sum + Math.max(0, entry.duration - 50), 0),
				reactCommits: commits.count,
				reactDurationMs: 0,
				reactMaxCommitMs: 0,
				...countDom(),
			}
		})
}

/** Installs the harness; `ready` flips once the first rows are on screen. */
export const installTranscriptBench = (): (() => void) => {
	const startedAt = performance.now()
	const harness: TranscriptBenchHarness = {
		ready: false,
		mountCommitMs: 0,
		countDom,
		runScroll: (steps = 160) => runScroll(steps),
	}
	window.__transcriptBench = harness
	const state = { handle: 0 }
	const poll = () => {
		if (document.querySelector(LIST_SELECTOR) === null) {
			state.handle = requestAnimationFrame(poll)
			return
		}
		harness.mountCommitMs = performance.now() - startedAt
		harness.ready = true
	}
	state.handle = requestAnimationFrame(poll)
	return () => {
		cancelAnimationFrame(state.handle)
		if (window.__transcriptBench === harness) delete window.__transcriptBench
	}
}
