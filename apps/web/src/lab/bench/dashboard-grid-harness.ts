/**
 * `window.__dashboardGridBench` for `perf/dashboard-grid.perf.spec.ts`. `react.commits`
 * counts DOM commits under the board (mutation batches), durations stay 0. A content render is one
 * run of the memoised tile view, which marks `TILE_RENDER_MARK`; the board reports its layout writes.
 */
interface ReactRenderMetrics {
	commits: number
	totalActualDurationMs: number
	actualDurationP95Ms: number
	maxActualDurationMs: number
}

interface InteractionMetrics {
	frames: number
	frameP95Ms: number
	droppedFrames: number
	longTasks: number
	totalBlockingMs: number
	react: ReactRenderMetrics
}

interface MountMetrics {
	mountMs: number
	layoutShift: number
	commits: number
}

export interface DashboardGridBenchHarness {
	ready: boolean
	beginInteraction: () => void
	endInteraction: () => Promise<InteractionMetrics>
	measureMount: () => Promise<MountMetrics>
	contentRenders: () => number
	layoutCommits: () => number
	lastCommitSize: () => number
}

declare global {
	interface Window {
		__dashboardGridBench?: DashboardGridBenchHarness
	}
}

export const TILE_RENDER_MARK = "dashboard-grid-bench:tile-render"
/** The board's counters, written by the view so the harness reads them without the Model. */
export const LAYOUT_COMMITS_ATTRIBUTE = "data-layout-commits"
export const LAST_COMMIT_SIZE_ATTRIBUTE = "data-last-commit-size"

const FRAME_MS = 1000 / 60

const percentile = (values: ReadonlyArray<number>, p: number): number => {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))] ?? 0
}

const nextPaint = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

/** The Mount sits on the element the view writes the counters to. */
const counter = (root: Element, attribute: string) => Number(root.getAttribute(attribute) ?? 0)

/**
 * The lifted tile and the resize ghost follow the pointer through style patches. A batch of only
 * those does not count.
 */
const isPointerFollow = (record: MutationRecord): boolean =>
	record.type === "attributes" &&
	record.attributeName === "style" &&
	record.target instanceof Element &&
	(record.target.hasAttribute("data-grid-item") ||
		record.target.matches('[aria-hidden="true"].border-dashed'))

/** Counts DOM commits (mutation batches) under `root` until the returned stop is called. */
const watchCommits = (root: Element) => {
	const commits = { count: 0 }
	const observer = new MutationObserver((records) => {
		if (!records.every(isPointerFollow)) commits.count++
	})
	observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
	return () => {
		observer.disconnect()
		return commits.count
	}
}

const reactMetrics = (commits: number): ReactRenderMetrics => ({
	commits,
	totalActualDurationMs: 0,
	actualDurationP95Ms: 0,
	maxActualDurationMs: 0,
})

/** `measureMount`: a remount timed to the second frame after, its layout shift and commits. */
const measureMount = (root: Element, requestRemount: () => void): Promise<MountMetrics> => {
	const shift = { value: 0 }
	const observer = new PerformanceObserver((list) =>
		list.getEntries().forEach((entry) => {
			if ("value" in entry && typeof entry.value === "number") shift.value += entry.value
		}),
	)
	observer.observe({ type: "layout-shift", buffered: false })
	const stopCommits = watchCommits(root)
	const startedAt = performance.now()
	requestRemount()
	return nextPaint().then(() => {
		const mountMs = performance.now() - startedAt
		return new Promise<MountMetrics>((resolve) =>
			setTimeout(() => {
				observer.disconnect()
				resolve({ mountMs, layoutShift: shift.value, commits: stopCommits() })
			}, 400),
		)
	})
}

type Interaction = { frames: Array<number>; longTasks: Array<PerformanceEntry>; stop: () => number }

/** Frame and long-task sampling plus DOM commits from `beginInteraction` to `endInteraction`. */
const startInteraction = (root: Element): Interaction => {
	const frames: Array<number> = []
	const longTasks: Array<PerformanceEntry> = []
	const sampling = { previous: performance.now(), handle: 0, running: true }
	const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries()))
	observer.observe({ entryTypes: ["longtask"] })
	const stopCommits = watchCommits(root)
	const sample = (now: number) => {
		frames.push(now - sampling.previous)
		sampling.previous = now
		if (sampling.running) sampling.handle = requestAnimationFrame(sample)
	}
	sampling.handle = requestAnimationFrame(sample)
	return {
		frames,
		longTasks,
		stop: () => {
			sampling.running = false
			cancelAnimationFrame(sampling.handle)
			observer.disconnect()
			return stopCommits()
		},
	}
}

const finish = (interaction: Interaction): InteractionMetrics => {
	const commits = interaction.stop()
	return {
		frames: interaction.frames.length,
		frameP95Ms: percentile(interaction.frames, 95),
		droppedFrames: interaction.frames.filter((duration) => duration > FRAME_MS * 1.5).length,
		longTasks: interaction.longTasks.length,
		totalBlockingMs: interaction.longTasks.reduce(
			(sum, entry) => sum + Math.max(0, entry.duration - 50),
			0,
		),
		react: reactMetrics(commits),
	}
}

/** The open interaction, and the readiness poll's frame. */
interface HarnessState {
	interaction: Interaction | null
	handle: number
}

/** Installs the harness on the bench root; `ready` flips once every tile's grip is on the page. */
export const installDashboardGridBench = (
	root: Element,
	count: number,
	requestRemount: () => void,
): (() => void) => {
	const state: HarnessState = { interaction: null, handle: 0 }
	const harness: DashboardGridBenchHarness = {
		ready: false,
		beginInteraction: () => {
			performance.clearMarks(TILE_RENDER_MARK)
			state.interaction?.stop()
			state.interaction = startInteraction(root)
		},
		endInteraction: () =>
			nextPaint().then(() => {
				const interaction = state.interaction ?? startInteraction(root)
				state.interaction = null
				return finish(interaction)
			}),
		measureMount: () => measureMount(root, requestRemount),
		contentRenders: () => performance.getEntriesByName(TILE_RENDER_MARK).length,
		layoutCommits: () => counter(root, LAYOUT_COMMITS_ATTRIBUTE),
		lastCommitSize: () => counter(root, LAST_COMMIT_SIZE_ATTRIBUTE),
	}
	window.__dashboardGridBench = harness
	const poll = () => {
		harness.ready = root.querySelectorAll("[data-bench-board] .widget-drag-handle").length >= count
		if (!harness.ready) state.handle = requestAnimationFrame(poll)
	}
	state.handle = requestAnimationFrame(poll)
	return () => {
		cancelAnimationFrame(state.handle)
		state.interaction?.stop()
		if (window.__dashboardGridBench === harness) delete window.__dashboardGridBench
	}
}
